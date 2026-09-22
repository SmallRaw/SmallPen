;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen
  (:require
   [app.common.data :as d]
   [app.common.geom.point :as gpt]
   [app.common.transit :as t]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.features.pointer-map :as fpmap]
   [app.main.data.notifications :as ntf]
   [app.main.data.persistence :as dps]
   [app.main.data.workspace.common :as dwc]
   [app.main.data.workspace.viewport :as dwv]
   [app.main.repo :as rp]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as local-session]
   [app.main.store :as st]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [app.util.timers :as tm]
   [potok.v2.core :as ptk]))

(defonce ^:private backend-url (atom nil))
(defonce ^:private event-source (atom nil))
(defonce ^:private workspace-state (atom nil))
(defonce ^:private workspace-promise (atom nil))
(defonce ^:private external-reconciliation? (atom false))
;; SP-045/046: Home renders the last routing failure so an unusable deep link
;; returns to an actionable Home instead of a silent redirect or a stuck loader.
(defonce home-notice (atom nil))

(def local-team-id local-session/local-team-id)

(def default-capability-profile
  {:ai-chat false
   :comments false
   :mcp false
   :plugins false
   :presence false
   :realtime-collaboration false
   :remote-history false})

(def ^:private capability-fields
  {:ai-chat :aiChat
   :comments :comments
   :mcp :mcp
   :plugins :plugins
   :presence :presence
   :realtime-collaboration :realtimeCollaboration
   :remote-history :remoteHistory})

(def ^:private default-command
  (get-method rp/cmd! :default))

(def ^:private fallback-commands
  (into {}
        (map (fn [id]
               [id (or (get-method rp/cmd! id) default-command)]))
        [:get-profile
         :get-enabled-flags
         :update-profile-props
         :update-profile
         :get-teams
         :get-team
         :get-team-members
         :get-font-variants
         :create-upload-session
         :upload-chunk
         :assemble-file-media-object
         :create-font-variant
         :update-font
         :delete-font
         :delete-font-variant
         :get-subscription-usage
         :get-file
         :get-view-only-bundle
         :update-file
         :upload-file-media-object
         :get-file-object-thumbnails
         :create-file-object-thumbnail
         :delete-file-object-thumbnails
         :get-file-libraries
         :get-comment-threads
         :get-profiles-for-file-comments
         :get-project
         :get-file-snapshots]))

(defn enabled?
  []
  (some? @backend-url))

(defn desktop-runtime?
  ([]
   (desktop-runtime? (unchecked-get js/globalThis "smallpenRuntime")))
  ([runtime]
   (true? (some-> runtime (unchecked-get "desktop")))))

(defn desktop-action-url
  [action]
  (when-not (contains? #{"create" "open"} action)
    (throw (ex-info "Unsupported SmallPen Desktop action"
                    {:type :validation :action action})))
  (str "smallpen://" action))

(defn request-desktop-action!
  [action]
  (set! (.-href js/location) (desktop-action-url action)))

(defn capability-enabled?
  [capability]
  (if-not (enabled?)
    true
    (let [field (get capability-fields capability)]
      (if field
        (true? (get-in @workspace-state [:capabilities field]
                       (get default-capability-profile capability)))
        false))))

(defn penpot-attributes-supported?
  [attributes]
  (if-not (enabled?)
    true
    (let [supported (->> (get-in @workspace-state
                                 [:format-capabilities :penpotWrite :attributes])
                         (into #{}))]
      (every? #(contains? supported (name %)) attributes))))

(defn penpot-attribute-supported?
  [attribute]
  (penpot-attributes-supported? [attribute]))

(defn penpot-page-attribute-supported?
  [attribute]
  (if-not (enabled?)
    true
    (contains? (->> (get-in @workspace-state
                            [:format-capabilities :penpotWrite :pageAttributes])
                    (into #{}))
               (name attribute))))

(defn canonical-node-type-supported?
  [node-type]
  (if-not (enabled?)
    true
    (contains? (->> (get-in @workspace-state
                            [:format-capabilities :canonicalPackage :nodeTypes])
                    (into #{}))
               node-type)))

(defn- fallback-command
  [id params]
  ((get fallback-commands id default-command) id params))

(defn- endpoint
  [path]
  (str @backend-url path))

(defn- package-selector
  [state]
  (cond
    (:file-id state) ["file-id" (:file-id state)]
    (:package-session-id state) ["package" (:package-session-id state)]
    :else nil))

(defn- package-endpoint
  [path]
  (let [[selector value] (package-selector @workspace-state)]
    (str (endpoint path)
         (when selector
           (str (if (str/includes? path "?") "&" "?")
                selector
                "="
                (js/encodeURIComponent value))))))

(defn- response-json
  [response]
  (-> (.json response)
      (.then
       (fn [body]
         (let [value (js->clj body :keywordize-keys true)]
           (if (.-ok response)
             value
             (let [error (:error value)]
               (throw (ex-info (or (:message error) "SmallPen backend request failed")
                               {:type :smallpen-backend
                                :code (some-> (:code error) keyword)
                                :details (:details error)
                                :status (.-status response)})))))))))

(defn- request
  ([path]
   (request path nil))
  ([path options]
   (let [options (or options #js {})
         headers (js/Headers. (unchecked-get options "headers"))]
     (when-let [file-id (:file-id @workspace-state)]
       (.set headers "x-smallpen-file" file-id))
     (when-let [session-id (:package-session-id @workspace-state)]
       (.set headers "x-smallpen-package" session-id))
     (unchecked-set options "headers" headers)
     (-> (js/fetch (endpoint path) options)
         (.then response-json)))))

(defn application-state
  []
  (request "/v1/application"))

(defn open-package
  [locator]
  (-> (js/fetch "/desktop/open-package"
                #js {:method "POST"
                     :headers #js {"content-type" "application/json"}
                     :body (js/JSON.stringify #js {:locator locator})})
      (.then response-json)))

(defn create-package
  [locator]
  (-> (js/fetch "/desktop/create-package"
                #js {:method "POST"
                     :headers #js {"content-type" "application/json"}
                     :body (js/JSON.stringify #js {:locator locator})})
      (.then response-json)))

(defn open-packages
  []
  (request "/v1/packages"))

(defn design-system-workspace
  "Read-only aggregation of the package design system (DSP-002-A)."
  []
  (request "/v1/ui/design-system"))

(defn- json-value
  [value]
  (cond
    (uuid? value)
    (str value)

    (keyword? value)
    (name value)

    (map? value)
    (into {}
          (map (fn [[key item]]
                 [(if (keyword? key) (name key) (str key))
                  (json-value item)]))
          value)

    (set? value)
    (mapv json-value value)

    (sequential? value)
    (mapv json-value value)

    :else
    value))

(defn- post-json
  [path value]
  (request path
           #js {:method "POST"
                :headers #js {"content-type" "application/json"}
                :body (js/JSON.stringify (clj->js (json-value value)))}))

(defn commit-operations
  "Apply a canonical Operation Batch to the selected Package (DSP-017-B)."
  [batch]
  (post-json "/v1/operations" batch))

(defn font-asset-url
  "Binary URL of a Package font asset served by the Background (DSP-008-A)."
  [id]
  (package-endpoint (str "/v1/font/" id)))

(defn canvas-workspace
  "Generated canvas surface: scene + layout + render payload (DSC-009/010).
  themes is an optional observational Workbench Combination."
  [themes]
  (let [query (if (seq themes)
                (str "?themes=" (str/join "," (map name themes)))
                "")]
    (request (str "/v1/ui/canvas" query))))

(defn- home-url
  []
  (let [home (js/URL. (.-href js/location))
        backend (.get (.-searchParams home) "smallpen-backend")
        package (.get (.-searchParams home) "smallpen-package")]
    (set! (.-hash home) "")
    (set! (.-search home) "?screen=smallpen-home")
    (when backend (.set (.-searchParams home) "smallpen-backend" backend))
    (when package (.set (.-searchParams home) "smallpen-package" package))
    home))

(defn- go-home-with-notice
  [notice]
  (reset! home-notice notice)
  ;; sessionStorage survives the same-tab navigation so Home renders the
  ;; notice regardless of which router transition mounts it first.
  (js/sessionStorage.setItem
   "smallpen-home-notice"
   (js/JSON.stringify (clj->js notice)))
  (let [home (home-url)]
    (let [target (.-href home)]
      (if (= target (.-href js/location))
        ;; Already on Home: the atom above is enough.
        nil
        ;; A full navigation also recovers a failed workspace bootstrap.
        (.replace js/location target)))))

(defn- workspace
  []
  (or @workspace-promise
      (let [pending (request "/v1/workspace")]
        (reset! workspace-promise pending)
        (.catch pending
                (fn [cause]
                  (when (identical? pending @workspace-promise)
                    (reset! workspace-promise nil))
                  (when (= :file_not_found (:code (ex-data cause)))
                    (go-home-with-notice
                     {:code "file_not_found"
                      :file-id (some-> (.-href js/location)
                                       (str/split #"[?#]" 2)
                                       (second)
                                       (js/URLSearchParams.)
                                       (.get "file-id"))}))
                  (when (= :file_identity_mismatch (:code (ex-data cause)))
                    ;; The backend refused to alias one locator to two file
                    ;; identities; never leak substitute content, surface the
                    ;; conflict on Home instead.
                    (go-home-with-notice
                     {:code "file_identity_mismatch"
                      :details (:details (ex-data cause))}))
                  (when (= :web_projection_failed (:code (ex-data cause)))
                    (let [details    (:details (ex-data cause))
                          cause-code (or (:causeCode details)
                                         "web_projection_failed")
                          cause-data (:causeDetails details)
                          object-id  (or (:instanceId cause-data)
                                         (:nodeId cause-data)
                                         (:componentId cause-data))
                          message   (str
                                     "SmallPen 无法在 Web 中加载这个设计。\n\n"
                                     "位置：" (:screenName details)
                                     " / " (:presentationName details)
                                     (when object-id (str "\n对象：" object-id))
                                     "\n错误：" cause-code
                                     "\n说明：" (ex-message cause)
                                     "\n\n原文件没有被修改，请修复上述对象后重新打开。")
                          home      (home-url)]
                      ;; A modal is intentional here: workspace initialization
                      ;; has failed, so a toast could disappear behind Penpot's
                      ;; loading surface. After acknowledgement, return to the
                      ;; SmallPen Home instead of leaving an endless spinner.
                      (js/alert message)
                      (.replace js/location (.-href home))))
                  (throw cause)))
        pending)))
(defn workspace-snapshot
  "Public handle to the memoized Package workspace snapshot promise
  (DSE-008). Rejects like the internal boot when the Package cannot load."
  []
  (workspace))


(defn- update-revision!
  [{:keys [revision]}]
  (when revision
    (swap! workspace-state assoc :revision revision)
    (reset! workspace-promise nil)))


(defn- snapshot-result
  [f]
  (->> (if (package-selector @workspace-state)
         (workspace)
         (-> (application-state)
             (.then
              (fn [{:keys [preferences]}]
                (local-session/home-snapshot preferences)))))
       (rx/from)
       (rx/map f)))

(defn- selected-file-state
  [id]
  {:file-id (str id)})

(defn- select-file!
  [id]
  (let [next-state (selected-file-state id)]
    (when (not= (:file-id next-state) (:file-id @workspace-state))
      (reset! workspace-promise nil)
      ;; 文件切换是完整的 Package 边界。旧修订、能力和会话都不能跨文件继承。
      (reset! workspace-state next-state))))

(defn- project-file
  [snapshot id libraries]
  (let [project-id (-> snapshot :runtime :project uuid/parse)
        result     (projection/project-snapshot
                    snapshot
                    {:file-id id
                     :libraries libraries
                     :project-id project-id})]
    (:file result)))

(defn- project-workspace-file
  [snapshot id]
  (let [project-id (-> snapshot :runtime :project uuid/parse)
        team-id    local-team-id
        libraries (or (:libraries snapshot) [])]
    (reset! workspace-state
            {:capabilities (:capabilities snapshot)
             :file-id (str id)
             :format-capabilities (:formatCapabilities snapshot)
             :library-snapshots
             (into {}
                   (map (fn [library]
                          [(get-in library [:runtime :file]) library]))
                   libraries)
             :package-session-id (:packageSessionId snapshot)
             :package-status (:packageStatus snapshot)
             :project-id project-id
             :revision (:revision snapshot)
             :team-id team-id})
    (when (:readOnly (:packageStatus snapshot))
      (st/emit! (dwc/set-workspace-read-only true))
      (st/emit!
       (ntf/show
        {:content "SmallPen Package 处于 Repair 状态：以最后有效的只读视图打开。"
         :level :error
         :timeout 30000
         :type :toast})))
    (when (seq (:projectionErrors snapshot))
      (let [{:keys [code message]} (first (:projectionErrors snapshot))
            total (count (:projectionErrors snapshot))]
        (st/async-emit!
         (ntf/show
          {:content (str "SmallPen 已安全加载，但有 " total
                         " 个投影错误。" code ": " message)
           :level :error
           :timeout 12000
           :type :toast}))))
    (project-file snapshot id libraries)))

(defn- open-library-file
  [id]
  (if-let [snapshot (get-in @workspace-state
                            [:library-snapshots (str id)])]
    (rx/of (project-file snapshot id (vals (:library-snapshots
                                            @workspace-state))))
    (rx/throw (ex-info "SmallPen Library snapshot is unavailable"
                       {:type :validation
                        :code :missing-smallpen-library
                        :file-id (str id)}))))

(defn- reconcile-library-files!
  [{:keys [libraries revision] :as result}]
  (let [file-id       (:file-id @workspace-state)
        library-files (mapv (fn [snapshot]
                              (-> (project-file snapshot
                                                (-> snapshot
                                                    :runtime
                                                    :file
                                                    uuid/parse)
                                                libraries)
                                  (assoc :is-shared true)
                                  (assoc :library-of (uuid/parse file-id))))
                            libraries)
        library-ids   (into #{} (map :id) library-files)]
    (swap! workspace-state
           assoc
           :library-snapshots
           (into {}
                 (map (fn [library]
                        [(get-in library [:runtime :file]) library]))
                 libraries))
    (when revision
      (swap! workspace-state assoc :revision revision))
    (reset! workspace-promise nil)
    (st/emit!
     (ptk/reify ::reconcile-library-files
       ptk/UpdateEvent
       (update [_ state]
         (update state :files
                 (fn [files]
                   (->> files
                        (remove (fn [[id file]]
                                  (and (= (:library-of file)
                                          (uuid/parse file-id))
                                       (not (contains? library-ids id)))))
                        (into {})
                        (merge (into {} (map (juxt :id identity))
                                     library-files))))))))
    result))

(defn libraries
  []
  (request "/v1/libraries"))

(defn link-library!
  [source]
  (-> (post-json "/v1/libraries/link" {:source source})
      (.then reconcile-library-files!)))

(defn unlink-library!
  [package-id]
  (-> (post-json "/v1/libraries/unlink" {:packageId package-id})
      (.then reconcile-library-files!)))

(defn refresh-library!
  [package-id]
  (-> (post-json "/v1/libraries/refresh" {:packageId package-id})
      (.then reconcile-library-files!)))

(defn- open-workspace
  [{:keys [id]}]
  (select-file! id)
  (snapshot-result #(project-workspace-file % id)))

(defn- open-viewer
  [{:keys [file-id]}]
  (select-file! file-id)
  (snapshot-result
   (fn [snapshot]
     (local-session/viewer-bundle
      snapshot
      (project-workspace-file snapshot file-id)))))

;; DSE-R11: change types that alter source STRUCTURE (as opposed to attribute
;; edits). When one commits while a generated page is open, the projection of
;; that page is stale and gets re-derived.
(def ^:private structural-change-types
  #{"add-obj" "del-obj" "mov-objects" "reorder-children" "reg-objects"
    "add-component" "del-component" "add-page" "del-page" "mov-page"})

(defn- generated-page-open?
  "True when the page currently open is a generated (projection-only) page:
  the Design System board or the Components overview."
  []
  (let [state   (deref st/state)
        page-id (:current-page-id state)
        file-id (:current-file-id state)
        page    (when (and page-id file-id)
                  (get-in state [:files (uuid/parse (str file-id))
                                 :data :pages-index page-id]))]
    (boolean
     (some (fn [[key _]]
             (and (string? key)
                  (or (str/starts-with? key "design-system")
                      (= key "components-page"))))
           (-> page :plugin-data :smallpen)))))

(defn- replace-projected-file
  "Swap the projected file data in place. Deterministic runtime ids keep open
  selections, undo entries and the current page valid across the swap."
  [file]
  (ptk/reify ::replace-projected-file
    ptk/UpdateEvent
    (update [_ state]
      (update state :files assoc (:id file) file))))

(defn- center-viewport-on-selection
  []
  (ptk/reify ::center-viewport-on-selection
    ptk/WatchEvent
    (watch [_ state _]
      (let [page-id  (:current-page-id state)
            file-id  (:current-file-id state)
            selected (first (get-in state [:workspace-local :selected]))
            shape    (when (and selected page-id file-id)
                       (get-in state [:files (uuid/parse (str file-id))
                                      :data :pages-index page-id
                                      :objects selected]))]
        (when shape
          (rx/of (dwv/update-viewport-position-center
                  (gpt/point (+ (:x shape) (/ (or (:width shape) 0) 2))
                             (+ (:y shape) (/ (or (:height shape) 0) 2))))))))))

(defn- restore-undo-stack
  "Restore the undo stack captured before a re-projection once the renderer's
  follow-up commits (text measurement, touched bookkeeping) have settled.
  Those ride-alongs are not user work; when they land after an undo they
  would truncate the redo tail. Skipped when newer work grew the stack in the
  meantime."
  [undo-stack]
  (ptk/reify ::restore-undo-stack
    ptk/WatchEvent
    (watch [_ _ _]
      (tm/schedule
       2500
       (fn []
         (st/emit!
          (ptk/reify ::restore-undo-stack!
            ptk/UpdateEvent
            (update [_ state]
              (let [current (get state :workspace-undo)]
                (if (< (count (get current :items []))
                       (count (get undo-stack :items [])))
                  (assoc state :workspace-undo undo-stack)
                  state)))))))
      (rx/empty))))

(defn- reproject-generated-page
  "Re-fetch the Package snapshot and swap the projected file data in place so
  the open generated page reflects the committed source. Waits for pending
  persistence first, then recenters the viewport on the current selection
  (e.g. the just-created component) so the new content is on screen. Token
  resyncs pass {:recenter? false}: the user stays where they are and keeps
  reading the panorama while the other combination columns update."
  [{:keys [recenter?] :or {recenter? true}}]
  (ptk/reify ::reproject-generated-page
    ptk/WatchEvent
    (watch [_ state _]
      (let [file-id    (:current-file-id state)
            undo-stack (get state :workspace-undo)]
        (when (and (enabled?) file-id)
          (->> (dps/wait-persisted 15000)
               (rx/mapcat (fn [_]
                            (reset! workspace-promise nil)
                            (->> (workspace)
                                 (rx/from)
                                 (rx/map
                                  (fn [snapshot]
                                    (project-file
                                     snapshot
                                     (uuid/parse (str file-id))
                                     (or (:libraries snapshot) []))))
                                 ;; Same pointer resolution as the boot path
                                 ;; (data.workspace/resolve-file): projected
                                 ;; files carry lazy pointers that must be
                                 ;; materialized before entering the store.
                                 (rx/mapcat
                                  (fn [file]
                                    (->> (fpmap/resolve-file file)
                                         (rx/map :data)
                                         (rx/map (fn [data]
                                                   (assoc file :data (d/removem (comp t/pointer? val) data)))))))
                                 (rx/map replace-projected-file))))
               (rx/mapcat (fn [event]
                            (if recenter?
                              (rx/of event
                                     (center-viewport-on-selection)
                                     (restore-undo-stack undo-stack))
                              (rx/of event
                                     (restore-undo-stack undo-stack)))))))))))

;; DSE-R26: canonical operations that change Token Cell values or the
;; project's active themes. When such a batch lands while a generated page
;; is open, bound content elsewhere on the board (the other combination
;; columns, alias displays, component and page occurrences) must resync.
(def ^:private token-operation-types
  #{"set-token-value" "set-active-token-themes" "replace-token-library"})

(defn- commit-workspace
  [{:keys [changes commit-id]}]
  (if (seq changes)
    (let [{:keys [file-id revision]} @workspace-state
          structural? (boolean
                       (some #(contains? structural-change-types
                                         (name (or (:type %) %)))
                             changes))]
      (->> (post-json "/v1/penpot/commit"
                      {:baseRevision revision
                       :changes changes
                       :commitId (str commit-id)})
           (rx/from)
           ;; 切换文件后到达的旧响应不能污染新文件的修订状态。
           (rx/tap (fn [response]
                     (when (= file-id (:file-id @workspace-state))
                       (update-revision! response)
                       ;; DSE-R11: structural source changes (create/undo/redo/
                       ;; delete of components or source objects) make the
                       ;; generated pages stale; while one is open, re-derive
                       ;; the projection so the change is visible in place.
                       (when (and structural? (generated-page-open?))
                         (st/async-emit! (reproject-generated-page {})))
                       ;; DSE-R26: token edits keep the viewport but resync
                       ;; every bound specimen through a fresh projection.
                       (when (and (generated-page-open?)
                                  (seq (->> (or (:operationTypes response) [])
                                            (filter token-operation-types)
                                            (distinct))))
                         (st/async-emit! (reproject-generated-page
                                          {:recenter? false}))))))))
    (rx/of {:revision (:revision @workspace-state)})))

(defn- upload-media
  [{:keys [content name]}]
  (when-not (instance? js/Blob content)
    (throw (ex-info "SmallPen Media upload requires a Blob"
                    {:type :validation
                     :code :invalid-media-blob})))
  (->> (request "/v1/media/import"
                #js {:method "POST"
                     :headers #js {"content-type" (.-type content)
                                   "x-smallpen-media-name" name}
                     :body content})
       (rx/from)
       (rx/tap update-revision!)
       (rx/map #(dissoc % :revision))))

(defn- upload-chunk
  [{:keys [content index session-id]}]
  (let [blob (first content)]
    (when-not (instance? js/Blob blob)
      (throw (ex-info "SmallPen chunk upload requires a Blob"
                      {:type :validation
                       :code :invalid-upload-chunk})))
    (->> (request (str "/v1/upload/session/" session-id "/chunk/" index)
                  #js {:method "POST"
                       :headers #js {"content-type" "application/octet-stream"}
                       :body blob})
         (rx/from))))

(defn- font-command
  [path params]
  (->> (post-json path params)
       (rx/from)
       (rx/tap update-revision!)))

(defn- empty-result
  []
  (rx/of []))

(defmethod rp/cmd! :get-profile
  [id params]
  (if (enabled?)
    (snapshot-result local-session/profile)
    (fallback-command id params)))

(defmethod rp/cmd! :get-enabled-flags
  [id params]
  (if (enabled?)
    ;; SmallPen is a local Package workspace. Returning no remote feature flags
    ;; keeps Penpot's official instrumentation lifecycle intact while preventing
    ;; it from starting telemetry/audit collection against a nonexistent server.
    (rx/of #{})
    (fallback-command id params)))

(defmethod rp/cmd! :update-profile-props
  [id params]
  (if (enabled?)
    (if-let [renderer (get-in params [:props :renderer])]
      (->> (post-json "/v1/preferences" {:renderer renderer})
           (rx/from)
           (rx/tap #(reset! workspace-promise nil)))
      (rx/of nil))
    (fallback-command id params)))

(defmethod rp/cmd! :update-profile
  [id params]
  (if (enabled?)
    (->> (-> (post-json "/v1/preferences"
                        {:language (or (:lang params) "")
                         :theme (or (:theme params) "dark")})
             (.then
              (fn [{:keys [preferences]}]
                (-> (workspace)
                    (.then
                     (fn [snapshot]
                       (local-session/profile
                        (assoc snapshot :preferences preferences))))))))
         (rx/from))
    (fallback-command id params)))

(defmethod rp/cmd! :get-teams
  [id params]
  (if (enabled?)
    (snapshot-result #(vector (local-session/team %)))
    (fallback-command id params)))

(defmethod rp/cmd! :get-team
  [id params]
  (if (enabled?)
    (snapshot-result local-session/team)
    (fallback-command id params)))

(defmethod rp/cmd! :get-team-members
  [id params]
  (if (enabled?)
    (snapshot-result #(vector (local-session/member %)))
    (fallback-command id params)))

(defmethod rp/cmd! :get-font-variants
  [id params]
  (if (enabled?)
    (snapshot-result local-session/font-variants)
    (fallback-command id params)))

(defmethod rp/cmd! :create-upload-session
  [id params]
  (if (enabled?)
    (->> (post-json "/v1/upload/session" params)
         (rx/from))
    (fallback-command id params)))

(defmethod rp/cmd! :upload-chunk
  [id params]
  (if (enabled?)
    (upload-chunk params)
    (fallback-command id params)))

(defmethod rp/cmd! :assemble-file-media-object
  [id params]
  (if (enabled?)
    (->> (font-command "/v1/media/assemble" params)
         (rx/map #(dissoc % :revision)))
    (fallback-command id params)))

(defmethod rp/cmd! :create-font-variant
  [id params]
  (if (enabled?)
    (->> (font-command "/v1/font/variant" params)
         (rx/map #(dissoc % :revision)))
    (fallback-command id params)))

(defmethod rp/cmd! :update-font
  [id params]
  (if (enabled?)
    (font-command "/v1/font/update" params)
    (fallback-command id params)))

(defmethod rp/cmd! :delete-font
  [id params]
  (if (enabled?)
    (font-command "/v1/font/delete" params)
    (fallback-command id params)))

(defmethod rp/cmd! :delete-font-variant
  [id params]
  (if (enabled?)
    (font-command "/v1/font/variant/delete" params)
    (fallback-command id params)))

(defmethod rp/cmd! :get-subscription-usage
  [id params]
  (if (enabled?)
    (rx/of {:editors 1})
    (fallback-command id params)))

(defmethod rp/cmd! :get-file
  [id params]
  (if (enabled?)
    ;; A different file id on the same page is a Package switch: known Library
    ;; snapshots project directly, anything else opens that Package. Falling
    ;; back to the library path first is what broke warm switching (the newly
    ;; created Package is not a Library snapshot yet).
    (or (when-let [snapshot (get-in @workspace-state
                                    [:library-snapshots (str (:id params))])]
          (rx/of (project-file snapshot
                               (uuid/parse (str (:id params)))
                               (vals (:library-snapshots @workspace-state)))))
        (open-workspace params))
    (fallback-command id params)))

(defmethod rp/cmd! :get-view-only-bundle
  [id params]
  (if (enabled?)
    (open-viewer params)
    (fallback-command id params)))

(defmethod rp/cmd! :update-file
  [id params]
  (if (enabled?)
    (commit-workspace params)
    (fallback-command id params)))

(defmethod rp/cmd! :upload-file-media-object
  [id params]
  (if (enabled?)
    (upload-media params)
    (fallback-command id params)))

(defmethod rp/cmd! :get-file-object-thumbnails
  [id params]
  (if (enabled?)
    (rx/of {})
    (fallback-command id params)))

(defmethod rp/cmd! :create-file-object-thumbnail
  [id params]
  (if (enabled?)
    (rx/of {})
    (fallback-command id params)))

(defmethod rp/cmd! :delete-file-object-thumbnails
  [id params]
  (if (enabled?)
    (rx/of {})
    (fallback-command id params)))

(defmethod rp/cmd! :get-file-libraries
  [id params]
  (if (enabled?)
    (->> (workspace)
         (rx/from)
         (rx/map
          (fn [snapshot]
            (mapv (fn [library]
                    {:id (-> library :runtime :file uuid/parse)
                     :is-indirect false
                     :name (get-in library [:manifest :name])})
                  (:libraries snapshot)))))
    (fallback-command id params)))

(defmethod rp/cmd! :get-comment-threads
  [id params]
  (if (enabled?)
    (empty-result)
    (fallback-command id params)))

(defmethod rp/cmd! :get-profiles-for-file-comments
  [id params]
  (if (enabled?)
    (empty-result)
    (fallback-command id params)))

(defmethod rp/cmd! :get-project
  [id params]
  (if (enabled?)
    (snapshot-result local-session/project)
    (fallback-command id params)))

(defmethod rp/cmd! :get-file-snapshots
  [id params]
  (if (enabled?)
    (empty-result)
    (fallback-command id params)))

(defn- freeze-for-external-reconciliation
  []
  (ptk/reify ::freeze-for-external-reconciliation
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (assoc-in [:permissions :can-edit] false)
          (assoc-in [:workspace-global
                     :persist-pending-while-read-only?]
                    true)))))

(defn- finish-external-reconciliation
  []
  (ptk/reify ::finish-external-reconciliation
    ptk/EffectEvent
    (effect [_ _ _]
      (.reload js/location))))

(defn- external-reconciliation-timeout
  []
  (ptk/reify ::external-reconciliation-timeout
    ptk/EffectEvent
    (effect [_ _ _]
      (reset! external-reconciliation? false)
      (js/alert
       "SmallPen preserved your local edits, but could not merge the external Package change automatically. Keep this window open and copy any unsaved work before reloading."))))

(defn- persist-before-external-reload
  []
  (ptk/reify ::persist-before-external-reload
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/concat
       (rx/of ::dps/force-persist)
       (->> (dps/wait-persisted 10000)
            (rx/map (fn [_] (finish-external-reconciliation)))
            (rx/if-empty (external-reconciliation-timeout)))))))

(defn- reconcile-external-change!
  [message update-product-revision?]
  (when (compare-and-set! external-reconciliation? false true)
    (reset! workspace-promise nil)
    (when update-product-revision?
      (when-let [revision (unchecked-get message "revision")]
        (swap! workspace-state assoc :revision revision)))
    (st/emit! (freeze-for-external-reconciliation)
              (dwc/set-workspace-read-only true)
              (persist-before-external-reload))))

(defn- start-events!
  []
  (some-> @event-source (.close))
  (let [source (js/EventSource. (endpoint "/v1/events"))]
    (set! (.-onmessage source)
          (fn [event]
            (let [message (js/JSON.parse (.-data event))
                  type    (unchecked-get message "type")]
              (case type
                "external-revision"
                (when (= (unchecked-get message "sessionId")
                         (:package-session-id @workspace-state))
                  (reconcile-external-change! message true))
                "external-recovered"
                (when (= (unchecked-get message "sessionId")
                         (:package-session-id @workspace-state))
                  (reconcile-external-change! message true))
                "package-dependency-changed"
                (when (= (unchecked-get message "sessionId")
                         (:package-session-id @workspace-state))
                  (reconcile-external-change! message false))
                "invalid-external-state"
                (when (= (unchecked-get message "sessionId")
                         (:package-session-id @workspace-state))
                  (swap! workspace-state assoc
                         :package-status
                         (-> (:package-status @workspace-state)
                             (assoc :readOnly true)
                             (assoc :state "repair")
                             (assoc :error
                                    (js->clj (unchecked-get message "error")
                                             :keywordize-keys true))))
                  ;; The backend keeps serving the last valid projection; stay
                  ;; on it read-only instead of reloading into a repair loop.
                  (st/emit! (dwc/set-workspace-read-only true))
                  (st/emit!
                   (ntf/show
                    {:content "SmallPen 检测到外部文件无效：已保留最后有效的只读视图，请修复文件后继续。"
                     :level :error
                     :timeout 30000
                     :type :toast}))
                  (js/console.error "SmallPen package is invalid; keeping the last valid workspace read-only"))
                nil))))
    (reset! event-source source)))

(defn runtime-options
  ([href]
   (runtime-options href (unchecked-get js/globalThis "smallpenRuntime")))
  ([href runtime]
   (let [url              (js/URL. href)
         parameters       (.-searchParams url)
         route-query      (some-> (.-hash url)
                                  (str/split #"\?" 2)
                                  (second))
         route-parameters (js/URLSearchParams. (or route-query ""))
         injected-backend (when runtime (unchecked-get runtime "backendUrl"))
         injected-package (when runtime (unchecked-get runtime "packageSessionId"))
         backend          (some-> (or injected-backend
                                      (.get parameters "smallpen-backend"))
                                  (str/replace #"/$" ""))
         package          (or injected-package
                              (.get parameters "smallpen-package"))
         file-id          (or (.get parameters "file-id")
                              (.get route-parameters "file-id"))]
     (cond-> {}
       (seq backend) (assoc :backend-url backend)
       (seq package) (assoc :package-session-id package)
       (seq file-id) (assoc :file-id file-id)))))

(defn- design-system-route?
  "The Workbench page reuses the SmallPen runtime (backend URL, events) but
  must not trigger the editor workspace projection."
  []
  (or (= "smallpen-design-system"
         (.get (js/URLSearchParams. (.-search js/location)) "screen"))
      (str/starts-with? (.-hash js/location) "#/design-system")))

(defn init!
  []
  (let [options            (runtime-options (.-href js/location))
        backend            (:backend-url options)
        file-id            (:file-id options)
        package-session-id (:package-session-id options)]
    (when backend
      (reset! backend-url backend)
      (reset! external-reconciliation? false)
      (reset! workspace-state
              (cond-> {}
                file-id (assoc :file-id file-id)
                package-session-id (assoc :package-session-id package-session-id)))
      (cf/set-file-media-resolver!
       (fn [{:keys [id]} thumbnail?]
         (package-endpoint
          (str "/v1/media/" id (when thumbnail? "/thumbnail")))))
      (cf/set-font-asset-resolver!
       (fn [id]
         (package-endpoint (str "/v1/font/" id))))
      (reset! workspace-promise nil)
      (when (and (or file-id package-session-id)
                 (not (design-system-route?)))
        (workspace))
      (start-events!))))

(defn import-tokens!
  "Review (or, with :apply true, apply) a DTCG token document against the
  selected Package. Resolves to the Background's {diff warnings library ...}."
  [params]
  (post-json "/v1/tokens/import" params))

(defn reload-after-external-write!
  "The Background wrote a new revision on our behalf outside Penpot's own
  persistence (for example a token import). Persist pending edits, then reload
  the workspace from the new revision exactly like an external change."
  [revision]
  (when revision
    (swap! workspace-state assoc :revision revision))
  (reset! workspace-promise nil)
  (when (compare-and-set! external-reconciliation? false true)
    (st/emit! (freeze-for-external-reconciliation)
              (dwc/set-workspace-read-only true)
              (persist-before-external-reload))))
