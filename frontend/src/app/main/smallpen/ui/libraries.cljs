;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.libraries
  "SmallPen content of the workspace libraries dialog: the Library sources
  linked to the open package, and the form to link a new one."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.smallpen :as smallpen]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [c tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn dialog-tabs
  "The libraries dialog shows a single tab in SmallPen."
  []
  [{:label (tr "workspace.libraries.libraries")
    :id "smallpen"}])

(defn- summary-line
  [{:keys [components graphics colors typographies tokens]
    :or {components 0 graphics 0 colors 0 typographies 0 tokens 0}}]
  (->> [(when (pos? components)
          (tr "workspace.libraries.components" (c components)))
        (when (pos? graphics)
          (tr "workspace.libraries.graphics" (c graphics)))
        (when (pos? colors)
          (tr "workspace.libraries.colors" (c colors)))
        (when (pos? typographies)
          (tr "workspace.libraries.typography" (c typographies)))
        (when (pos? tokens)
          (tr "workspace.libraries.smallpen.tokens" (c tokens)))]
       (remove nil?)
       (str/join " · ")))

(defn- source-text
  [source]
  (case (:type source)
    "foundation" (str (tr "workspace.libraries.smallpen.foundation") " · " (:path source))
    "url" (:url source)
    "local" (:path source)
    ""))

(mf/defc library-item*
  {::mf/private true}
  [{:keys [library busy on-action]}]
  (let [{:keys [name packageId source summary]} library
        source-type (:type source)
        source-text (source-text source)
        disabled?   (some? busy)

        on-refresh
        (mf/use-fn
         (mf/deps on-action packageId)
         #(on-action packageId (smallpen/refresh-library! packageId)))

        on-unlink
        (mf/use-fn
         (mf/deps on-action packageId)
         #(on-action packageId (smallpen/unlink-library! packageId)))]
    [:div {:class (stl/css :library-item)
           :data-testid "smallpen-library-item"}
     [:div {:class (stl/css :library-content)}
      [:div {:class (stl/css :library-name)} name]
      [:div {:class (stl/css :library-source)
             :title source-text}
       source-text]
      [:div {:class (stl/css :library-summary)}
       (summary-line summary)]]
     [:div {:class (stl/css :library-actions)}
      (when (= "url" source-type)
        [:> icon-button* {:type "button"
                          :aria-label (tr "labels.refresh")
                          :icon i/reload
                          :variant "secondary"
                          :disabled disabled?
                          :on-click on-refresh}])
      (when (not= "foundation" source-type)
        [:> icon-button* {:type "button"
                          :aria-label (tr "workspace.libraries.unlink-library-btn")
                          :icon i/detach
                          :variant "secondary"
                          :disabled disabled?
                          :on-click on-unlink}])]]))

(mf/defc libraries-tab*
  []
  (let [result*      (mf/use-state nil)
        result       (deref result*)
        source-type* (mf/use-state "url")
        source-type  (deref source-type*)
        source*      (mf/use-state "")
        source       (deref source*)
        busy*        (mf/use-state nil)
        busy         (deref busy*)
        error*       (mf/use-state nil)
        error        (deref error*)
        url?         (= source-type "url")

        directory-input-ref (mf/use-ref nil)

        load-libraries
        (mf/use-fn
         (fn []
           (-> (smallpen/libraries)
               (.then #(reset! result* %))
               (.catch #(reset! error* (ex-message %))))))

        run-action
        (mf/use-fn
         (mf/deps load-libraries)
         (fn [action promise]
           (reset! busy* action)
           (reset! error* nil)
           (-> promise
               (.then (fn [_]
                        (reset! busy* nil)
                        (load-libraries)))
               (.catch (fn [cause]
                         (reset! busy* nil)
                         (reset! error* (ex-message cause)))))))

        select-url
        (mf/use-fn
         (fn [_]
           (reset! source-type* "url")
           (reset! source* "")))

        select-local
        (mf/use-fn
         (fn [_]
           (reset! source-type* "local")
           (reset! source* "")))

        change-source
        (mf/use-fn
         (fn [event]
           (reset! source* (dom/get-value (dom/get-target event)))))

        browse-library
        (mf/use-fn
         (fn [_]
           (.click (mf/ref-val directory-input-ref))))

        upload-library
        (mf/use-fn
         (fn [event]
           (let [input (dom/get-target event)
                 files (vec (array-seq (js/Array.from (.-files input))))]
             (set! (.-value input) "")
             (when (seq files)
               (reset! busy* :browse)
               (reset! error* nil)
               (-> (smallpen/import-local-library! files)
                   (.then (fn [{:keys [path]}]
                            (when path (reset! source* path))
                            (reset! busy* nil)))
                   (.catch (fn [cause]
                             (reset! busy* nil)
                             (reset! error* (ex-message cause)))))))))

        add-library
        (mf/use-fn
         (mf/deps source url? run-action)
         (fn [_]
           (let [descriptor (if url?
                              {:type "url" :url source}
                              {:type "local" :path source})]
             (run-action :link (smallpen/link-library! descriptor)))))]

    (mf/with-effect []
      (load-libraries)
      js/undefined)

    [:div {:class (stl/css :libraries-content)}
     [:section {:class (stl/css :library-section)}
      [:> title-bar* {:collapsable false
                      :title (tr "workspace.libraries.in-this-file")
                      :class (stl/css :title-spacing)}]
      (if (nil? result)
        [:div {:class (stl/css :library-list-empty)}
         (tr "workspace.libraries.loading")]
        [:div {:class (stl/css :library-list)}
         (for [library (:libraries result)]
           [:> library-item* {:key (:packageId library)
                              :library library
                              :busy busy
                              :on-action run-action}])])]

     [:section {:class (stl/css :library-section)}
      [:> title-bar* {:collapsable false
                      :title (tr "workspace.libraries.smallpen.add-source")
                      :class (stl/css :title-spacing)}]
      [:div {:class (stl/css :library-form)}
       [:div {:class (stl/css :source-switch)}
        [:button {:type "button"
                  :disabled (some? busy)
                  :class (stl/css-case :source-option true
                                       :source-selected url?)
                  :on-click select-url}
         (tr "workspace.libraries.smallpen.remote-url")]
        [:button {:type "button"
                  :disabled (some? busy)
                  :class (stl/css-case :source-option true
                                       :source-selected (not url?))
                  :on-click select-local}
         (tr "workspace.libraries.smallpen.local-path")]]
       [:label {:class (stl/css :source-label)}
        (if url?
          (tr "workspace.libraries.smallpen.remote-url")
          (tr "workspace.libraries.smallpen.local-path"))
        [:input {:class (stl/css :source-input)
                 :disabled (some? busy)
                 :value source
                 :placeholder (if url?
                                "https://design.example/library/"
                                "../libraries/design-system.smallpen")
                 :on-change change-source}]]
       (when-not url?
         [:> button* {:variant "secondary"
                      :type "button"
                      :disabled (some? busy)
                      :on-click browse-library}
          (if (= busy :browse)
            (tr "labels.uploading")
            (tr "workspace.libraries.smallpen.browse"))])
       [:input {:type "file"
                :ref directory-input-ref
                :hidden true
                :webkitdirectory "true"
                :multiple true
                :on-change upload-library}]
       [:p {:class (stl/css :source-help)}
        (if url?
          (tr "workspace.libraries.smallpen.remote-help")
          (tr "workspace.libraries.smallpen.local-help"))]
       (when (seq error)
         [:p {:class (stl/css :library-error)} error])
       [:> button* {:variant "primary"
                    :type "button"
                    :disabled (or (str/blank? source) (some? busy))
                    :on-click add-library}
        (if (= busy :link)
          (tr "labels.adding")
          (tr "labels.add"))]]]]))
