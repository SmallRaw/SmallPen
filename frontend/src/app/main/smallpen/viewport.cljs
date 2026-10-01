;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.viewport
  "Per-page viewport memory for generated Design System pages. The generated
  page is re-projected on every load, so its pan/zoom is kept in session
  storage and restored instead of fitting the board again. Every function is
  a no-op for pages that are not Design System pages."
  (:require
   [app.main.data.helpers :as dsh]
   [app.main.smallpen.edit-policy :as dsep]
   [app.util.storage :as storage]))

(def ^:private storage-key ::workspace-viewports)

(defn valid-viewport?
  [{:keys [zoom vbox]}]
  (and (number? zoom)
       (pos? zoom)
       (number? (:width vbox))
       (pos? (:width vbox))
       (number? (:height vbox))
       (pos? (:height vbox))))

(defn- design-system-page?
  [state file-id page-id]
  (dsep/design-system-page?
   (dsh/get-page (dsh/lookup-file-data state file-id) page-id)))

(defn- stored-viewport
  [file-id page-id]
  (let [local (get-in storage/session [storage-key [file-id page-id]])]
    (when (valid-viewport? local) local)))

(defn persist-current-viewport!
  "Store the current pan/zoom when the current page is a Design System page."
  [state]
  (let [file-id (:current-file-id state)
        page-id (:current-page-id state)
        local   (:workspace-local state)]
    (when (and file-id
               page-id
               (design-system-page? state file-id page-id)
               (valid-viewport? local))
      (binding [storage/*sync* true]
        (swap! storage/session assoc-in
               [storage-key [file-id page-id]]
               (select-keys local [:zoom :zoom-inverse :vbox]))))))

(defn restore-viewport
  "Seed the workspace cache of the target Design System page with its stored
  viewport, so page initialization restores it."
  [state file-id page-id design-system?]
  (let [file-id (or file-id (:current-file-id state))
        page-id (or page-id (:current-page-id state)
                    (first (:pages (dsh/lookup-file-data state file-id))))
        local   (when design-system? (stored-viewport file-id page-id))]
    (if (and local
             (not (valid-viewport?
                   (get-in state [:workspace-cache [file-id page-id]]))))
      (assoc-in state [:workspace-cache [file-id page-id]] local)
      state)))

(defn initial-board-id
  "Return the one-shot board target only when this page has no usable cached
  viewport. Page initialization restores cached workspace-local state, so a
  reopened generated page must not be fitted again over the user's pan/zoom."
  [state file-id page-id board-id design-system?]
  (if-not design-system?
    board-id
    (let [local (or (get-in state [:workspace-cache [file-id page-id]])
                    (stored-viewport file-id page-id))]
      (when-not (valid-viewport? local)
        board-id))))
