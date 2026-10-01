;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.toolbar
  "SmallPen entries of the workspace top toolbar."
  (:require
   [app.main.data.event :as ev]
   [app.main.data.workspace :as dw]
   [app.main.smallpen :as smallpen]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc tokens-panel-button*
  "Toggles the token matrix panel in the left sidebar. `class` is the
  toolbar's own option class."
  [{:keys [layout class]}]
  (let [on-toggle
        (mf/use-fn
         (mf/deps layout)
         (fn []
           (when (contains? layout :collapse-left-sidebar)
             (st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))
           (st/emit! (dw/remove-layout-flag :shortcuts)
                     (dw/remove-layout-flag :debug-panel)
                     (-> (dw/toggle-layout-flag :tokens-panel)
                         (vary-meta assoc ::ev/origin "workspace-left-toolbar")))))]
    (when (smallpen/enabled?)
      [:li {:class class}
       [:> icon-button* {:variant "ghost"
                         :tooltip-placement "bottom"
                         :aria-pressed (contains? layout :tokens-panel)
                         :aria-label (tr "workspace.assets.tokens")
                         :data-testid "smallpen-tokens-toolbar-button"
                         :icon i/tokens
                         :on-click on-toggle}]])))
