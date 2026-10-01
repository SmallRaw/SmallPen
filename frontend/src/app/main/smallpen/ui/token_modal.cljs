;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.ui.token-modal
  "Centered placement of the token create/edit modal, used by the SmallPen
  token matrix (`:position :center`)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.main.smallpen :as smallpen]
   [app.main.ui.hooks :as hooks]
   [rumext.v2 :as mf]))

(defn undo-group
  "SmallPen undoes a token edit and its propagation as one step; Penpot
  keeps them as separate undo entries (nil group)."
  []
  (when (smallpen/enabled?)
    (uuid/next)))

(defn target-set
  "Returns `[set-id tokens]` for the Set a token form edits: the Set given
  to the modal when it differs from the selected one (the SmallPen matrix
  edits a variant Set), else the selected Set and its tokens."
  [target-set-id selected-set-id selected-tokens tokens-lib]
  (if (and (some? target-set-id)
           (not= target-set-id selected-set-id))
    [target-set-id (or (some-> tokens-lib (ctob/get-tokens target-set-id)) {})]
    [selected-set-id selected-tokens]))

(def ^:private gap
  "Space kept between the modal and its owner bounds, in px."
  16)

(defn centered-style
  "Style that centers the modal inside `owner-bounds` (the distances, in
  px, from each viewport edge), or inside the viewport without bounds."
  [owner-bounds]
  (let [{:keys [top right bottom left]
         :or {top 0 right 0 bottom 0 left 0}} owner-bounds
        inset #(str (+ gap (max 0 %)) "px")]
    {:top (inset top)
     :right (inset right)
     :bottom (inset bottom)
     :left (inset left)
     :maxHeight (str "calc(100vh - " (+ (* 2 gap) (max 0 top) (max 0 bottom)) "px)")}))

(mf/defc backdrop*
  "Dims the workspace behind a centered modal. It lives in the modal portal,
  outside the modal node, so a press on it closes the modal through the
  modal click-outside handling."
  []
  (let [container (hooks/use-portal-container :modal)]
    (mf/portal
     (mf/html [:div {:class (stl/css :backdrop)}])
     container)))
