;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.routing
  "SmallPen routing: every route keeps the local Package connection,
  workspace URLs omit the synthetic local team id, and the Design System
  entry opens the generated page in the ordinary workspace."
  (:require
   [app.common.data :as d]
   [app.common.uri :as u]
   [app.common.uuid :as uuid]
   [app.main.data.common :as dcm]
   [app.main.errors :as errors]
   [app.main.router :as rt]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.viewport :as spvp]
   [app.main.store :as st]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.util.globals :as globals]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private connection-params
  [:smallpen-backend :smallpen-package])

(defn- current-connection-params
  []
  (-> (or (some-> globals/location .-search (str/replace #"^\?" "")) "")
      (u/query-string->map)
      (select-keys connection-params)))

(defn route-params
  [id params]
  (cond-> (merge (current-connection-params) params)
    (= id :workspace) (dissoc :team-id)))

(defn redirect
  "Return the event that replaces navigating to `match`, or nil. SmallPen
  has no dashboard: a missing screen or a dashboard route opens Home, and
  SmallPen screens do not exist outside SmallPen."
  [match query-params]
  (let [screen (get-in match [:data :name])]
    (cond
      (and (smallpen/enabled?)
           (or (nil? (rt/get-query-param query-params :screen))
               (some-> screen name (str/starts-with? "dashboard"))))
      (rt/nav :smallpen-home)

      (and (contains? #{:smallpen-home :smallpen-design-system} screen)
           (not (smallpen/enabled?)))
      (rt/assign-exception {:type :not-found}))))

(defn viewer-frame-nav
  "SmallPen interactions may target a board on another page: return the
  viewer navigation to that page and board, or nil. Penpot keeps
  `go-to-frame` inside the current page."
  [state frame-id]
  (when (smallpen/enabled?)
    (some (fn [[page-id page]]
            (when-some [index (d/index-of-pred (:frames page) #(= (:id %) frame-id))]
              (rt/nav :viewer (assoc (rt/get-params state)
                                     :page-id page-id
                                     :index index))))
          (get-in state [:viewer :pages]))))

(defn- persist-viewport
  []
  (spvp/persist-current-viewport! @st/state))

(defn install!
  "Install the SmallPen route adapter and viewport persistence; a no-op
  outside SmallPen."
  []
  (when (smallpen/enabled?)
    (rt/set-params-adapter! route-params)
    (.addEventListener js/window "pagehide" persist-viewport)))

(mf/defc design-system-entry*
  {::mf/props :obj}
  ;; DSE-008: the system page entry resolves the generated Design System
  ;; page id from the Package snapshot, then opens the ordinary workspace
  ;; editor on it. Refresh/deep links restore the same page via :page-id.
  [{:keys [file-id]}]
  (mf/with-effect []
    (-> (smallpen/workspace-snapshot)
        (.then
         (fn [snapshot]
           (let [runtime  (js->clj snapshot :keywordize-keys true)
                 ;; js->clj keywordize keeps the original camelCase of the
                 ;; JSON keys; no kebab-case conversion happens here.
                 page-id  (get-in runtime [:runtime :designSystemPage])
                 file-id  (or file-id (get-in runtime [:runtime :file]))
                 ;; DSE-R13: hand the board's runtime id to the workspace so
                 ;; the initial viewport zooms to the full board.
                 board-id (get-in runtime [:runtime :designSystem :board])]
             (st/emit! (dcm/go-to-workspace
                        :team-id smallpen/local-team-id
                        :file-id (some-> file-id uuid/parse*)
                        :page-id (some-> page-id uuid/parse*)
                        :board-id board-id
                        :design-system? true)))))
        (.catch errors/on-error)))
  [:> loader*
   {:title (tr "labels.loading")
    :overlay true}])
