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

(defn- format-opened-at
  [value]
  (try
    (.format (js/Intl.DateTimeFormat.
              js/undefined
              #js {:dateStyle "medium" :timeStyle "short"})
             (js/Date. value))
    (catch :default _
      value)))

(mf/defc package-card*
  {::mf/private true
   ::mf/props :obj}
  [{:keys [active lastOpenedAt locator name open role status on-open opening]}]
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
       locator]
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
           (reset! package-dialog-action* action)
           (reset! package-dialog-open* true)))

        choose-package
        (mf/use-fn
         (fn [_]
           (if (smallpen/desktop-runtime?)
             (smallpen/request-desktop-action! "open")
             (show-package-dialog :open))))

        new-package
        (mf/use-fn
         (fn [_]
           (if (smallpen/desktop-runtime?)
             (smallpen/request-desktop-action! "create")
             (show-package-dialog :create))))

        close-package-dialog
        (mf/use-fn
         (fn []
           (reset! package-dialog-open* false)))

        change-package-dialog
        (mf/use-fn
         (fn [open]
           (reset! package-dialog-open* open)))

        change-package-locator
        (mf/use-fn
         (fn [event]
           (reset! package-locator* (-> event dom/get-target dom/get-value))))

        submit-package
        (mf/use-fn
         (mf/deps package-dialog-action package-locator open-package create-package)
         (fn [event]
           (dom/prevent-default event)
           (when-let [locator (some-> package-locator str/trim not-empty)]
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
                  (smallpen/open-packages)])
            (.then
             (fn [values]
               (when-not @disposed
                 ;; 保留已暂存的 routing notice，不被应用状态拉取覆盖。
                 (swap! state assoc
                        :application (aget values 0)
                        :error nil
                        :loading false
                        :opening nil
                        :sessions (aget values 1)))))
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
        [:span
         (case (keyword (:code notice))
           :file_not_found
           "找不到这个文件：它可能已被移动、重命名或删除。请从下面的列表重新打开，或新建一个 Package。"
           :file_identity_mismatch
           "这个地址指向的文件身份已发生变化（同一位置现在是另一个 Package）。请从下面的列表重新打开正确的 Package。"
           "SmallPen 无法打开这个链接。请从下面的列表重新打开，或新建一个 Package。")]
        [:> button* {:on-click dismiss-notice
                     :variant "secondary"
                     :type "button"}
         "知道了"]])
     [:> modal* {:is-open package-dialog-open
                 :on-open-change change-package-dialog
                 :size "small"}
      [:form {:on-submit submit-package}
       [:> modal-header* {:title (tr (if (= package-dialog-action :create)
                                       "smallpen.home.new-package"
                                       "smallpen.home.open-package"))}]
       [:> modal-content* {}
        [:> input* {:auto-focus true
                    :default-value ""
                    :label (tr (if (= package-dialog-action :create)
                                 "smallpen.home.new-prompt"
                                 "smallpen.home.open-prompt"))
                    :on-change change-package-locator
                    :variant "comfortable"}]]
       [:> modal-footer* {}
        [:> button* {:on-click close-package-dialog
                     :type "button"
                     :variant "secondary"}
         (tr "labels.cancel")]
        [:> button* {:disabled (str/blank? package-locator)
                     :on-click submit-package
                     :type "button"}
         (tr (if (= package-dialog-action :create)
               "labels.create"
               "labels.open"))]]]]

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

      (when error
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
         (for [{:keys [active lastOpenedAt locator name open role status]} packages]
           [:> package-card* {:active active
                              :key locator
                              :lastOpenedAt lastOpenedAt
                              :locator locator
                              :name name
                              :on-open open-package
                              :open open
                              :opening opening
                              :role role
                              :status status}])])]]))

(mf/defc smallpen-home-page*
  {::mf/lazy-load true}
  []
  [:> smallpen-home*])
