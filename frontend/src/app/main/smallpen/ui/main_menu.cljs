;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.main-menu
  "SmallPen entries of the workspace main menu. Callers pass the menu's
  own CSS module classes so the entries look like their siblings."
  (:require
   [app.main.router :as rt]
   [app.main.smallpen :as smallpen]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu-item*]]
   [app.main.ui.context :as ctx]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- open-home
  [event]
  (dom/stop-propagation event)
  (st/emit! (rt/nav :smallpen-home)))

(defn- open-settings
  [event]
  (dom/stop-propagation event)
  (st/emit! (rt/nav :settings-options)))

(mf/defc home-item*
  [{:keys [item-class name-class]}]
  (when (smallpen/enabled?)
    [:> dropdown-menu-item* {:class item-class
                             :on-click open-home
                             :id "file-menu-smallpen-home"}
     [:span {:class name-class}
      (tr "smallpen.home.navigation")]]))

(mf/defc preferences-items*
  [{:keys [item-class name-class]}]
  (let [file-id (mf/use-ctx ctx/current-file-id)

        open-design-system
        (mf/use-fn
         (mf/deps file-id)
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (rt/nav :smallpen-design-system {"file-id" (str file-id)}))))]
    (when (smallpen/enabled?)
      [:*
       [:> dropdown-menu-item* {:on-click open-settings
                                :class item-class
                                :id "file-menu-smallpen-settings"}
        [:span {:class name-class}
         (tr "labels.settings")]]
       (when (some? file-id)
         [:> dropdown-menu-item* {:on-click open-design-system
                                  :class item-class
                                  :id "file-menu-smallpen-design-system"}
          [:span {:class name-class}
           (tr "smallpen.design-system")]])])))
