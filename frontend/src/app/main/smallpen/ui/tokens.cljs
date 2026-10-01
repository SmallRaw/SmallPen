;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.tokens
  "SmallPen entry points for the workspace left sidebar token panels."
  (:require
   [app.main.data.workspace :as dw]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.token-state :as spts]
   [app.main.store :as st]
   [app.main.ui.workspace.tokens.matrix :refer [token-matrix*]]
   [app.main.ui.workspace.tokens.quick-panel :refer [quick-token-panel*]]
   [app.main.ui.workspace.tokens.sidebar :refer [tokens-sidebar-tab*]]
   [rumext.v2 :as mf]))

(defn- use-library-with-status
  [tokens-lib tokens-status]
  (mf/with-memo [tokens-lib tokens-status]
    (spts/library-with-status tokens-lib tokens-status)))

(mf/defc quick-tokens-tab*
  {::mf/private true}
  [{:keys [tokens-lib tokens-status current-tokens resolved-current-tokens]}]
  (let [tokens-lib (use-library-with-status tokens-lib tokens-status)]
    [:> quick-token-panel* {:tokens-lib tokens-lib
                            :active-tokens current-tokens
                            :resolved-active-tokens resolved-current-tokens}]))

(mf/defc tokens-tab*
  "The left sidebar Tokens tab: Penpot's token sidebar, or the SmallPen
  quick token panel (which reads the active, not the force-set, tokens)."
  [{:keys [tokens-lib tokens-status active-tokens resolved-active-tokens scroll-store
           current-tokens resolved-current-tokens]}]
  (if (smallpen/enabled?)
    [:> quick-tokens-tab* {:tokens-lib tokens-lib
                           :tokens-status tokens-status
                           :current-tokens current-tokens
                           :resolved-current-tokens resolved-current-tokens}]
    [:> tokens-sidebar-tab* {:tokens-lib tokens-lib
                             :tokens-status tokens-status
                             :active-tokens active-tokens
                             :resolved-active-tokens resolved-active-tokens
                             :scroll-store scroll-store}]))

(defn- close-token-matrix
  []
  (st/emit! (dw/remove-layout-flag :tokens-panel)))

(mf/defc token-matrix-panel*
  "Full-height token matrix opened from the SmallPen toolbar."
  [{:keys [tokens-lib tokens-status]}]
  (let [tokens-lib (use-library-with-status tokens-lib tokens-status)]
    [:> token-matrix* {:tokens-lib tokens-lib
                       :initial-expanded true
                       :show-expand-action false
                       :on-close close-token-matrix}]))
