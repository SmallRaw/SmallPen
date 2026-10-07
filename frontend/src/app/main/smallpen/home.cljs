;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.home
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.router :as rt]
   [app.main.smallpen :as smallpen]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.layout.modal :refer [modal-content* modal-footer* modal-header* modal*]]
   [app.main.ui.ds.product.empty-placeholder :refer [empty-placeholder*]]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.util.dom :as dom]
   [app.util.globals :as globals]
   [app.util.i18n :refer [tr]]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(defn package-items
  [application sessions]
  (let [open-by-package-id (into {}
                                 (map (juxt :packageId identity))
                                 (:packages sessions))]
    (mapv
     (fn [{:keys [packageId] :as recent}]
       (let [session (get open-by-package-id packageId)]
         (assoc recent
                :active (true? (:active session))
                :open (some? session)
                :status (:status session))))
     (:recentPackages application))))

(defn package-role-label
  [role]
  (some-> role str/capitalize))

(defn package-opening?
  [opening locator]
  (and (some? locator) (= opening locator)))

(defn notice-message
  [notice]
  (case (keyword (:code notice))
    :file_not_found
    (tr "smallpen.home.notice.file-not-found")
    :file_identity_mismatch
    (tr "smallpen.home.notice.file-identity-mismatch")
    (tr "smallpen.home.notice.link-unavailable")))

(defn- format-opened-at
  [value]
  (try
    (.format (js/Intl.DateTimeFormat.
              js/undefined
              #js {:dateStyle "medium" :timeStyle "short"})
             (js/Date. value))
    (catch :default _
      value)))

(defn- short-locator
  "The end of a Package path: copies of one Package share a name and a long
  common prefix, so the folders next to the file tell them apart."
  [locator]
  (let [parts (str/split (str locator) #"/")]
    (if (> (count parts) 4)
      (str "…/" (str/join "/" (take-last 3 parts)))
      locator)))

(mf/defc package-card*
  {::mf/private true
   ::mf/props :obj}
  [{:keys [active lastOpenedAt locator name nativeName open role status on-open opening]}]
  (let [opening?   (package-opening? opening locator)
        repair?    (= "repair" (:state status))
        role-label (package-role-label role)]
    [:article {:class (stl/css-case :package-card true
                                    :active active
                                    :repair repair?)}
     [:div {:class (stl/css :package-icon)}
      [:> icon* {:icon-id i/document :size "l"}]]
     [:div {:class (stl/css :package-copy)}
      [:div {:class (stl/css :package-heading)}
       [:> heading* {:level 3 :typography t/title-medium}
        name]
       (when open
         [:> text* {:as "span"
                    :class (stl/css :status)
                    :typography t/body-small}
          (if repair?
            (tr "smallpen.home.repair")
            (tr "smallpen.home.open"))])]
      [:> text* {:class (stl/css :path)
                 :title locator
                 :typography t/body-small}
       (if nativeName
         (tr "smallpen.home.local-directory" nativeName)
         (short-locator locator))]
      [:div {:class (stl/css :metadata)}
       (when role-label
         [:> text* {:as "span" :typography t/body-small}
          role-label])
       [:> text* {:as "span" :typography t/body-small}
        (format-opened-at lastOpenedAt)]]]
     [:> button* {:variant "secondary"
                  :on-click #(on-open locator)
                  :disabled opening?}
      (if opening?
        (tr "labels.loading")
        (tr "labels.open"))]]))

(mf/defc smallpen-home*
  []
  (let [state (mf/use-state {:application nil
                             :error nil
                             :loading true
                             :opening nil
                             :sessions nil})
        package-dialog-open* (mf/use-state false)
        package-dialog-action* (mf/use-state :open)
        package-locator*     (mf/use-state "")
        uploading*          (mf/use-state false)
        uploading           @uploading*
        native-directory?   (smallpen/native-directory-supported?)
        directory-input-ref (mf/use-ref nil)
        package-dialog-open  @package-dialog-open*
        package-dialog-action @package-dialog-action*
        package-locator      @package-locator*
        {:keys [application error loading opening sessions notice]} @state
        packages (when (and application sessions)
                   (package-items application sessions))

        open-package
        (mf/use-fn
         (fn [locator]
           (swap! state assoc :error nil :opening locator)
           (-> (smallpen/open-package locator)
               (.then
                (fn [{:keys [url]}]
                  (set! (.-href globals/location) url)))
               (.catch
                (fn [cause]
                  (swap! state assoc
                         :error (or (ex-message cause)
                                    (tr "errors.generic"))
                         :opening nil))))))

        create-package
        (mf/use-fn
         (fn [locator]
           (swap! state assoc :error nil :opening locator)
           (-> (smallpen/create-package locator)
               (.then
                (fn [{:keys [url]}]
                  (set! (.-href globals/location) url)))
               (.catch
                (fn [cause]
                  (swap! state assoc
                         :error (or (ex-message cause)
                                    (tr "errors.generic"))
                         :opening nil))))))

        show-package-dialog
        (mf/use-fn
         (fn [action]
           (swap! state assoc :error nil)
           (reset! package-dialog-action* action)
           (reset! package-dialog-open* true)))

        browse-package
        (mf/use-fn
         (fn [_]
           (if native-directory?
             (do
               (reset! uploading* true)
               (swap! state assoc :error nil)
               (-> (smallpen/open-local-directory!)
                   (.then (fn [{:keys [url]}] (set! (.-href globals/location) url)))
                   (.catch (fn [cause]
                             (when-not (= "AbortError" (.-name cause))
                               (swap! state assoc :error (smallpen/local-file-error cause)))))
                   (.finally #(reset! uploading* false))))
             (.click (mf/ref-val directory-input-ref)))))

        upload-package
        (mf/use-fn
         (fn [event]
           (let [input (dom/get-target event)
                 files (vec (array-seq (js/Array.from (.-files input))))]
             (set! (.-value input) "")
             (when (seq files)
               (reset! uploading* true)
               (swap! state assoc :error nil)
               (-> (smallpen/import-package! files)
                   (.then (fn [{:keys [url]}]
                            (set! (.-href globals/location) url)))
                   (.catch (fn [cause]
                             (swap! state assoc :error (or (ex-message cause)
                                                           (tr "errors.generic")))))
                   (.finally #(reset! uploading* false)))))))

        choose-package
        (mf/use-fn
         (fn [_]
           (cond
             (smallpen/desktop-runtime?) (smallpen/request-desktop-action! "open")
             native-directory? (browse-package nil)
             :else (show-package-dialog :open))))

        new-package
        (mf/use-fn
         (fn [_]
           (if (smallpen/desktop-runtime?)
             (smallpen/request-desktop-action! "create")
             (show-package-dialog :create))))

        close-package-dialog
        (mf/use-fn
         (fn []
           (when-not @uploading*
             (reset! package-dialog-open* false))))

        change-package-dialog
        (mf/use-fn
         (fn [open]
           (when-not @uploading*
             (reset! package-dialog-open* open))))

        change-package-locator
        (mf/use-fn
         (fn [event]
           (reset! package-locator* (-> event dom/get-target dom/get-value))))

        submit-package
        (mf/use-fn
         (mf/deps package-dialog-action package-locator open-package create-package)
         (fn [event]
           (dom/prevent-default event)
           (when-let [locator (when-not @uploading*
                                (some-> package-locator str/trim not-empty))]
             (reset! package-dialog-open* false)
             (reset! package-locator* "")
             ((if (= package-dialog-action :create)
                create-package
                open-package)
              locator))))

        open-settings
        (mf/use-fn #(st/emit! (rt/nav :settings-options)))

        dismiss-notice
        (mf/use-fn
         (fn []
           (reset! smallpen/home-notice nil)
           (js/sessionStorage.removeItem "smallpen-home-notice")
           (swap! state assoc :notice nil)))]

    (mf/with-effect []
      ;; SP-045/046: routing failures from workspace deep links surface here as
      ;; an actionable notice; Home stays usable and no substitute package opens.
      ;; The notice is staged in sessionStorage by the redirector, so the mount
      ;; order of Home vs the redirect cannot lose it.
      (when-let [staged (js/sessionStorage.getItem "smallpen-home-notice")]
        (swap! state assoc :notice (js->clj (js/JSON.parse staged) :keywordize-keys true)))
      (dom/set-html-title "SmallPen")
      (let [disposed (atom false)]
        (-> (js/Promise.all
             #js [(smallpen/application-state)
                  (smallpen/open-packages)
                  (smallpen/local-directories)])
            (.then
             (fn [values]
               (when-not @disposed
                 ;; 保留已暂存的 routing notice，不被应用状态拉取覆盖。
                 (let [names (into {} (map (juxt :locator :name)) (aget values 2))]
                   (swap! state assoc
                          :application (update (aget values 0) :recentPackages
                                               #(mapv (fn [item] (assoc item :nativeName (get names (:locator item)))) %))
                          :error nil
                          :loading false
                          :opening nil
                          :sessions (aget values 1))))))
            (.catch
             (fn [cause]
               (when-not @disposed
                 (swap! state assoc
                        :error (or (ex-message cause) (tr "errors.generic"))
                        :loading false)))))
        #(reset! disposed true)))

    [:main {:class (stl/css :home)
            :data-testid "smallpen-home"}
     (when notice
       [:div {:data-testid "smallpen-home-notice"
              :role "alert"
              :style #js {:alignItems "center"
                          :backgroundColor "#fef3c7"
                          :border "1px solid #f59e0b"
                          :borderRadius "8px"
                          :boxSizing "border-box"
                          :color "#78350f"
                          :display "flex"
                          :gap "12px"
                          :justifyContent "space-between"
                          :margin "16px auto 0"
                          :maxWidth "960px"
                          :padding "12px 16px"
                          :width "calc(100% - 32px)"}}
        [:span (notice-message notice)]
        [:> button* {:on-click dismiss-notice
                     :variant "secondary"
                     :type "button"}
         (tr "smallpen.home.notice.dismiss")]])
     [:> modal* {:is-open package-dialog-open
                 :on-open-change change-package-dialog
                 :size "small"}
      [:form {:on-submit submit-package}
       [:> modal-header* {:title (if (= package-dialog-action :create)
                                   (tr "smallpen.home.new-package")
                                   (tr "smallpen.home.open-package"))}]
       [:> modal-content* {}
        (when (= package-dialog-action :open)
          [:div {:class (stl/css :upload-options)}
           [:> button* {:type "button"
                        :icon i/folder
                        :disabled uploading
                        :on-click browse-package}
            (if uploading
              (tr "labels.uploading")
              (tr "smallpen.home.upload-folder"))]
           [:input {:type "file"
                    :hidden true
                    :ref directory-input-ref
                    :webkitdirectory "true"
                    :multiple true
                    :on-change upload-package}]])
        [:> input* {:auto-focus (= package-dialog-action :create)
                    :disabled uploading
                    :default-value ""
                    :label (if (= package-dialog-action :create)
                             (tr "smallpen.home.new-prompt")
                             (tr "smallpen.home.open-server-prompt"))
                    :on-change change-package-locator
                    :variant "comfortable"}]
        (when error
          [:> text* {:class (stl/css :error)
                     :role "alert"
                     :typography t/body-medium}
           error])]
       [:> modal-footer* {}
        [:> button* {:on-click close-package-dialog
                     :disabled uploading
                     :type "button"
                     :variant "secondary"}
         (tr "labels.cancel")]
        [:> button* {:disabled (or uploading (str/blank? package-locator))
                     :on-click submit-package
                     :type "button"}
         (if (= package-dialog-action :create)
           (tr "labels.create")
           (tr "labels.open"))]]]]

     [:header {:class (stl/css :header)}
      [:div
       [:> heading* {:level 1 :typography t/display}
        "SmallPen"]
       [:> text* {:class (stl/css :subtitle) :typography t/body-large}
        (tr "smallpen.home.subtitle")]]
      [:div {:class (stl/css :header-actions)}
       [:> button* {:icon i/add :on-click new-package}
        (tr "smallpen.home.new-package")]
       [:> button* {:variant "secondary"
                    :icon i/folder
                    :disabled uploading
                    :on-click choose-package}
        (tr "smallpen.home.open-package")]
       [:> button* {:variant "secondary"
                    :icon i/settings
                    :on-click open-settings}
        (tr "labels.settings")]]]

     [:section {:class (stl/css :content)
                :aria-labelledby "smallpen-recent-title"}
      [:> heading* {:id "smallpen-recent-title"
                    :level 2
                    :typography t/title-large}
       (tr "smallpen.home.recent")]

      (when (and error (not package-dialog-open))
        [:> text* {:class (stl/css :error) :typography t/body-medium}
         error])

      (cond
        loading
        [:> loader* {:title (tr "labels.loading")}]

        (empty? packages)
        [:> empty-placeholder* {:title (tr "smallpen.home.empty-title")
                                :subtitle (tr "smallpen.home.empty-subtitle")
                                :type 1}]

        :else
        [:div {:class (stl/css :package-grid)}
         (for [{:keys [active lastOpenedAt locator name nativeName open role status]} packages]
           [:> package-card* {:active active
                              :key locator
                              :lastOpenedAt lastOpenedAt
                              :locator locator
                              :name name
                              :nativeName nativeName
                              :on-open open-package
                              :open open
                              :opening opening
                              :role role
                              :status status}])])]]))

(mf/defc smallpen-home-page*
  {::mf/lazy-load true}
  []
  [:> smallpen-home*])
