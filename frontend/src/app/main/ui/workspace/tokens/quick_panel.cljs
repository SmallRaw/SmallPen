;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.tokens.quick-panel
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.types.shape.layout :as ctsl]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.layers.layer-button :refer [layer-button*]]
   [app.main.ui.workspace.tokens.management.group :as group]
   [app.main.ui.workspace.tokens.management.token-pill :refer [token-pill*]]
   [app.main.ui.workspace.tokens.matrix :refer [combination-dialog*]]
   [app.main.ui.workspace.tokens.matrix-data :as matrix-data]
   [app.main.ui.workspace.tokens.quick-panel-data :as quick-panel-data]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc quick-token-panel*
  [{:keys [class tokens-lib active-tokens resolved-active-tokens]}]
  (let [user-can-edit? (mf/use-ctx ctx/can-edit?)
        read-only?     (mf/use-ctx ctx/workspace-read-only?)
        can-edit?      (and user-can-edit? (not read-only?))
        objects        (mf/deref refs/workspace-page-objects)
        selected       (mf/deref refs/selected-shapes)
        editing-ref    (mf/deref refs/workspace-editor-state)
        edition        (mf/deref refs/selected-edition)

        selected-shapes
        (mf/with-memo [selected objects]
          (into [] (keep (d/getf objects)) selected))

        selected-inside-layout?
        (mf/with-memo [selected-shapes objects]
          (boolean (some #(ctsl/any-layout-immediate-child? objects %)
                         selected-shapes)))

        not-editing?
        (and (empty? editing-ref)
             (not (and (some? edition)
                       (= :text (:type (get objects edition))))))

        axes
        (mf/with-memo [tokens-lib]
          (matrix-data/project-axes tokens-lib))

        token-groups
        (mf/with-memo [active-tokens]
          (quick-panel-data/group-active-tokens active-tokens))

        combination-open* (mf/use-state false)

        open-combination
        (mf/use-fn
         (fn []
           (when can-edit?
             (reset! combination-open* true))))

        change-combination
        (mf/use-fn
         (fn [value axis]
           (when-let [variant (some #(when (= (str (:id %)) value) %)
                                    (:variants axis))]
             (st/emit! (dwtl/activate-token-matrix-variant
                        (:name axis)
                        (:set-id variant))))))

        apply-token
        (mf/use-fn
         (mf/deps not-editing? selected selected-shapes)
         (fn [event token]
           (dom/stop-propagation event)
           (when (not= (:type token) :number)
             (cond
               (and not-editing? (seq selected-shapes))
               (st/emit! (dwta/toggle-token {:token token
                                             :shape-ids selected}))

               (seq selected-shapes)
               (st/emit!
                (ntf/show {:content (tr "workspace.tokens.error-text-edition")
                           :type :toast
                           :level :warning
                           :timeout 3000}))))))]

    [:div {:class (dm/str class " " (stl/css :quick-token-panel))
           :data-testid "smallpen-quick-token-panel"}
     (when (seq axes)
       [:div {:class (stl/css :combination-section)}
        [:> button* {:variant "secondary"
                     :icon i/settings
                     :class (stl/css :combination-button)
                     :data-testid "smallpen-token-combination-button"
                     :disabled (not can-edit?)
                     :on-click open-combination}
         (tr "workspace.tokens.matrix.current-combination")]])

     [:div {:class (stl/css :quick-token-scroll)}
      (if (seq token-groups)
        [:div
         (for [{:keys [type tokens]} token-groups]
           [:section {:key (name type)
                      :class (stl/css :quick-token-group)}
            [:> layer-button* {:label (or (get-in dwta/token-properties [type :title])
                                          (name type))
                               :description (str (count tokens))
                               :expanded true
                               :icon (group/token-section-icon type)}]
            [:div {:class (stl/css :quick-token-list)}
             (for [token tokens]
               [:> token-pill* {:key (str (:id token))
                                :token token
                                :selected-shapes selected-shapes
                                :is-selected-inside-layout selected-inside-layout?
                                :active-theme-tokens resolved-active-tokens
                                :on-click apply-token}])]])]
        [:> text* {:as "p"
                   :typography "body-small"
                   :class (stl/css :quick-token-empty)}
         (tr "workspace.tokens.no-active-sets")])]

     [:> combination-dialog* {:axes axes
                              :show (and can-edit? @combination-open*)
                              :on-change change-combination
                              :on-close #(reset! combination-open* false)}]]))
