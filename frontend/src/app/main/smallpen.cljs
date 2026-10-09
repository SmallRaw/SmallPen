;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.transit :as t]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.changes :as-alias dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.persistence :as dps]
   [app.main.data.workspace :as-alias dw]
   [app.main.data.workspace.common :as dwc]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.viewport :as dwv]
   [app.main.features.pointer-map :as fpmap]
   [app.main.repo :as rp]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as local-session]
   [app.main.store :as st]
   [app.util.i18n :as i18n :refer [tr]]
   [app.util.timers :as tm]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]))

(defonce ^:private backend-url (atom nil))
(defonce ^:private event-source (atom nil))
(defonce ^:private workspace-state (atom nil))
(defonce ^:private workspace-promise (atom nil))
(defonce ^:private external-reconciliation? (atom false))
;; Every Package write moves the revision, so writes go out one at a time:
;; a commit is based on the revision left by the write before it.
(defonce ^:private write-queue (atom (js/Promise.resolve nil)))
;; The latest revisions this window's own writes produced.
(defonce ^:private own-revisions (atom []))
;; Runtime ids of Media uploaded for a shape (Penpot's `:is-local`) that no
;; saved change references yet.
(defonce ^:private local-media (atom #{}))
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
         :get-environment-data
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

(defn local-files-runtime?
  ([] (local-files-runtime? (unchecked-get js/globalThis "smallpenRuntime")))
  ([runtime] (true? (some-> runtime (unchecked-get "localFiles")))))

(defn choose-local-package!
  [action]
  (if-let [ready (unchecked-get js/globalThis "smallpenLocalFilesReady")]
    (-> ready
        (.then (fn [module] ((unchecked-get module "choosePackage") action)))
        (.then #(js->clj % :keywordize-keys true)))
    (js/Promise.reject (js/Error. "Local file service is unavailable"))))

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

(defn native-directory-supported?
  []
  (and (not (desktop-runtime?))
       (not (local-files-runtime?))
       (true? (unchecked-get js/globalThis "isSecureContext"))
       (fn? (unchecked-get js/globalThis "showDirectoryPicker"))
       (some? (unchecked-get js/globalThis "smallpenNativeFilesReady"))))

(defn- native-files-call
  [method & args]
  (if-let [ready (unchecked-get js/globalThis "smallpenNativeFilesReady")]
    (.then ready (fn [module]
                   (.apply (unchecked-get module method) nil (to-array args))))
    (js/Promise.resolve nil)))

(defn local-directories
  []
  (-> (native-files-call "localDirectories")
      (.then #(js->clj % :keywordize-keys true))))

(defn open-local-directory!
  []
  ;; Call the picker directly in the button gesture, before any promise wait.
  (-> (.showDirectoryPicker js/window #js {:mode "readwrite"})
      (.then #(native-files-call "openDirectory" % @backend-url))
      (.then #(js->clj % :keywordize-keys true))))

(defn local-file-error
  [cause]
  (case (unchecked-get cause "code")
    "native_permission_required" (tr "smallpen.local.permission-required")
    "native_file_conflict" (tr "smallpen.local.file-conflict")
    "native_missing_manifest" (tr "smallpen.local.invalid-folder")
    "native_upload_limit" (tr "smallpen.local.folder-too-large")
    (or (ex-message cause) (tr "smallpen.local.save-failed"))))

(defn- sync-local-directory!
  [file-id & [revision]]
  (-> (native-files-call "syncPackage" file-id @backend-url
                         #js {:onCommit (fn []
                                          (when revision
                                            (swap! own-revisions #(->> (conj % revision) (take-last 64) vec))
                                            (when (= file-id (:file-id @workspace-state))
                                              (swap! workspace-state assoc :revision revision)
                                              (reset! workspace-promise nil))))})
      (.catch
       (fn [cause]
         (let [message (local-file-error cause)]
           (st/emit! (ntf/show {:content message :level :error :timeout nil}))
           (throw (ex-info message {:type :persistence
                                    :code :local-directory-save-failed}
                           cause)))))))

(defn- request
  ([path]
   (request path nil))
  ([path options]
   (let [options (or options #js {})
         headers (js/Headers. (unchecked-get options "headers"))
         file-id (:file-id @workspace-state)]
     (when file-id
       (.set headers "x-smallpen-file" file-id))
     (when-let [session-id (:package-session-id @workspace-state)]
       (.set headers "x-smallpen-package" session-id))
     (unchecked-set options "headers" headers)
     (-> (if (and file-id (= path "/v1/workspace"))
           (sync-local-directory! file-id)
           (js/Promise.resolve nil))
         (.then (fn [_] (js/fetch (endpoint path) options)))
         (.then response-json)
         (.then (fn [value]
                  (if (and file-id (:revision value)
                           (= "POST" (unchecked-get options "method")))
                    ;; The service commit is durable even if browser writeback
                    ;; fails. Only a bound directory adopts it before the ack.
                    (-> (sync-local-directory! file-id (:revision value))
                        (.then (constantly value)))
                    value)))))))

(defn application-state
  []
  (request "/v1/application"))

(defn open-package
  [locator]
  (-> (native-files-call "prepareOpen" locator @backend-url)
      (.then (fn [_] (js/fetch "/desktop/open-package"
                               #js {:method "POST"
                                    :headers #js {"content-type" "application/json"}
                                    :body (js/JSON.stringify #js {:locator locator})})))
      (.then response-json)))

(defn create-package
  [locator]
  (-> (js/fetch "/desktop/create-package"
                #js {:method "POST"
                     :headers #js {"content-type" "application/json"}
                     :body (js/JSON.stringify #js {:locator locator})})
      (.then response-json)))

(defn directory-upload-form
  [files]
  (let [form (js/FormData.)]
    (doseq [file files
            :when (not-any? #(str/starts-with? % ".")
                            (str/split (.-webkitRelativePath file) #"/"))]
      (.append form (.-webkitRelativePath file) file (.-name file)))
    form))

(defn import-package!
  [files]
  (-> (js/fetch "/packages/import"
                #js {:method "POST" :body (directory-upload-form files)})
      (.then response-json)))

(defn open-packages
  []
  (request "/v1/packages"))

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

(defn- serialized-write
  "Start the Package write `start` (a thunk returning a promise) once every
  earlier write has settled. A Media import that lands while a commit is in
  flight moves the revision under it, and the Background then rejects the
  commit as stale (409)."
  [start]
  (let [result (.then @write-queue (fn [_] (start)))]
    (reset! write-queue
            (-> result
                (.then (fn [{:keys [revision]}]
                         (when revision
                           (swap! own-revisions
                                  #(->> (conj % revision) (take-last 64) (vec))))))
                (.catch (constantly nil))))
    result))

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

(defn- key-text
  [k]
  (if (keyword? k) (subs (str k) 1) (str k)))

(defn- expand-design-system-refs
  "Merge the compact wire form (\"compact-1\", web-projection.mjs
  compactDesignSystemRefs) back into full component sample sources."
  [{:keys [componentAxes componentBindings] :as refs}]
  (if (not= "compact-1" (:format refs))
    refs
    (-> refs
        (dissoc :componentAxes :componentBindings :format)
        (update :componentSamples
                (fn [samples]
                  (mapv
                   (fn [{:keys [ownerPackageId sources] :as compact}]
                     (let [sample (-> compact
                                      (dissoc :ownerPackageId :sources)
                                      (assoc :axes (get componentAxes (keyword (:componentSetId compact)))))]
                       (assoc sample :sources
                              (into {}
                                    (map (fn [[k item]]
                                           (let [node-id (key-text k)]
                                             [k (cond-> {:kind "component-sample"
                                                         :componentId (:componentSetId sample)
                                                         :variantId (:variantId sample)
                                                         :ownerPackageId ownerPackageId
                                                         :nodeId (or (:nodeId item) node-id)
                                                         :displayNodeId node-id
                                                         :combinationId (:combinationId sample)
                                                         :combinationLabel (:combinationLabel sample)
                                                         :familyName (:familyName sample)
                                                         :selection (:selection sample)
                                                         :occurrencePath (when (:occurrence item) node-id)
                                                         :bindings (into {}
                                                                         (map (fn [[field index]]
                                                                                [field (nth componentBindings index)]))
                                                                         (:bindings item))}
                                                  (:allCombinations sample)
                                                  (assoc :allCombinations true)

                                                  (not (:occurrence item))
                                                  (assoc :overrideNodeId nil)

                                                  (and (:occurrence item) (some? (:overrideNodeId item)))
                                                  (assoc :overrideNodeId (:overrideNodeId item)))])))
                                    sources))))
                   samples))))))

(defn- with-design-system-refs
  "The Background serves the generated Design System page data on its own
  route; merge it into the snapshot the projection reads."
  [snapshot]
  (if (and (get-in snapshot [:runtime :designSystemRefsDeferred])
           (some? (get-in snapshot [:runtime :designSystemPage])))
    (-> (request (str "/v1/design-system-refs?revision="
                      (js/encodeURIComponent (str (:revision snapshot)))
                      "&locale="
                      (js/encodeURIComponent (str i18n/*current-locale*))))
        (.then (fn [{:keys [designSystemRefs designSystemPage]}]
                 (-> snapshot
                     (assoc-in [:runtime :designSystemRefs]
                               (expand-design-system-refs designSystemRefs))
                     (assoc-in [:runtime :designSystemTree] designSystemPage)))))
    (js/Promise.resolve snapshot)))

(defn- workspace
  []
  (or @workspace-promise
      (let [pending (.then (request "/v1/workspace") with-design-system-refs)]
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
                          message   (str/join
                                     "\n"
                                     (remove nil?
                                             [(tr "smallpen.load.projection-failed")
                                              ""
                                              (tr "smallpen.load.location"
                                                  (str (:screenName details))
                                                  (str (:presentationName details)))
                                              (when object-id
                                                (tr "smallpen.load.object" (str object-id)))
                                              (tr "smallpen.load.error-code" (str cause-code))
                                              (tr "smallpen.load.error-message" (str (ex-message cause)))
                                              ""
                                              (tr "smallpen.load.file-unchanged")]))
                          home      (home-url)]
                      ;; A modal is intentional here: workspace initialization
                      ;; has failed, so a toast could disappear behind Penpot's
                      ;; loading surface. After acknowledgement, return to the
                      ;; SmallPen Home instead of leaving an endless spinner.
                      (js/alert message)
                      (.replace js/location (.-href home))))
                  ;; Callers receive the rejection through `pending`; this
                  ;; branch only reacts to it. Rethrowing here would reject
                  ;; the discarded `.catch` promise as an unhandled rejection.
                  nil))
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

(def ^:private history-cleared-key "smallpen-history-cleared")

(defn- session-storage
  []
  (unchecked-get js/globalThis "sessionStorage"))

(defn- take-history-cleared-notice!
  "True once for the Package session whose history an external revision
  cleared."
  [session-id]
  (let [storage (session-storage)]
    (when (and (some? session-id)
               (some? storage)
               (= session-id (.getItem storage history-cleared-key)))
      (.removeItem storage history-cleared-key)
      true)))

(defn- stale-instances-notice
  "The Repair notice of a Package opened read-only. When the only Repair is
  Instances whose variant their Foundation renamed or deleted, the file
  still opens: say they show the closest variant until they are repaired."
  [status]
  (let [conflicts (:conflicts status)]
    (if (and (seq conflicts) (every? #(true? (:degraded %)) conflicts))
      (tr "smallpen.load.stale-instances" (count conflicts))
      (tr "smallpen.load.repair-read-only"))))

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
        {:content (stale-instances-notice (:packageStatus snapshot))
         :level :error
         :timeout 30000
         :type :toast})))
    (when (take-history-cleared-notice! (:packageSessionId snapshot))
      (st/async-emit!
       (ntf/show
        {:content (tr "smallpen.external.history-cleared")
         :level :info
         :timeout 10000
         :type :toast})))
    (when (seq (:projectionErrors snapshot))
      (let [{:keys [code message]} (first (:projectionErrors snapshot))
            total (count (:projectionErrors snapshot))]
        (st/async-emit!
         (ntf/show
          {:content (tr "smallpen.load.projection-errors" total (str code) (str message))
           :level :error
           :timeout 12000
           :type :toast}))))
    (project-file snapshot id libraries)))

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
  (-> (serialized-write #(post-json "/v1/libraries/link" {:source source}))
      (.then reconcile-library-files!)))

(defn import-local-library!
  [files]
  (request "/v1/libraries/import-local"
           #js {:method "POST" :body (directory-upload-form files)}))

(defn unlink-library!
  [package-id]
  (-> (serialized-write #(post-json "/v1/libraries/unlink" {:packageId package-id}))
      (.then reconcile-library-files!)))

(defn refresh-library!
  [package-id]
  (-> (serialized-write #(post-json "/v1/libraries/refresh" {:packageId package-id}))
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

(defn generated-page?
  "True for projection-only pages (generated Design System board, Components
  overview) that can never be a write destination."
  [page]
  (boolean
   (some (fn [[key _]]
           (and (string? key)
                (or (str/starts-with? key "design-system")
                    (= key "components-page"))))
         (-> page :plugin-data :smallpen))))

(defn unmeasured-text?
  "True when a frame holds a text that has no `position-data` yet. Packages
  do not store that derived attribute; until the viewport measures the text
  it renders as a `foreignObject`, which taints the rasterizer canvas.
  Empty texts are never measured."
  [objects frame-id]
  (and (enabled?)
       (boolean
        (some #(and (cfh/text-shape? %) (nil? (:position-data %)))
              (cfh/get-children-with-self objects frame-id)))))

(defn- generated-page-open?
  "True when the page currently open is a generated (projection-only) page."
  []
  (let [state   (deref st/state)
        page-id (:current-page-id state)
        file-id (:current-file-id state)]
    (and (some? page-id)
         (some? file-id)
         (generated-page?
          (get-in state [:files (uuid/parse (str file-id))
                         :data :pages-index page-id])))))

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

(def ^:private undo-settle-ms 2500)

(defn- settled-undo-stack
  "The undo stack to keep once the renderer's follow-up commits after a
  re-projection have settled. Those ride-alongs (text measurement, touched
  bookkeeping) are not user work; when they land after an undo they truncate
  the redo tail. The captured stack comes back only when it had a redo tail
  that newer entries replaced (not a redo of it), every entry up to its
  index is still in place, and the user has not undone into the newer
  entries. Otherwise current wins."
  [captured current]
  (let [index     (get captured :index -1)
        items     (vec (get captured :items []))
        kept      (inc index)
        cur-items (vec (get current :items []))
        cur-index (get current :index -1)]
    (if (and (< kept (count items))
             (< kept (count cur-items))
             (= cur-index (dec (count cur-items)))
             (not= (nth cur-items kept) (nth items kept))
             (= (subvec items 0 kept) (subvec cur-items 0 kept)))
      captured
      current)))

(defn- user-edit?
  "A local commit that opens its own undo entry. The renderer's follow-ups
  after a re-projection (text measurement, layout reflow) save no undo or
  stack onto the current entry."
  [commit]
  (boolean
   (and (= :local (:source commit))
        (:save-undo? commit)
        (not (:stack-undo? commit))
        (seq (:undo-changes commit)))))

(defn- restore-undo-stack
  "Once the renderer's follow-up commits after the swap (`swapped`) have
  settled, put back the undo stack captured before the re-projection (see
  `settled-undo-stack`). A user edit since the capture truncates the redo
  tail on purpose and cancels the restore, as does leaving the workspace. A
  restore never applies to a different file than the one it was captured on."
  [file-id undo-stack swapped stream]
  (->> swapped
       (rx/take 1)
       (rx/mapcat (fn [_] (rx/timer undo-settle-ms)))
       (rx/map (fn [_]
                 (ptk/reify ::restore-undo-stack!
                   ptk/UpdateEvent
                   (update [_ state]
                     (if (= file-id (:current-file-id state))
                       (update state :workspace-undo
                               #(settled-undo-stack undo-stack %))
                       state)))))
       (rx/take-until
        (rx/merge
         (->> stream
              (rx/filter (ptk/type? ::dch/commit))
              (rx/map deref)
              (rx/filter user-edit?))
         (rx/filter (ptk/type? ::dw/finalize-workspace) stream)))))

(defn- current-projection?
  "A re-projection result applies only to the file it was requested for and
  only while it still matches the revision the workspace is on."
  [file-id snapshot]
  (let [{current-file :file-id current-revision :revision} @workspace-state]
    (and (= (str file-id) current-file)
         (some? (:revision snapshot))
         (= (:revision snapshot) current-revision))))

(defn- reproject-generated-page
  "Re-fetch the Package snapshot and swap the projected file data in place so
  the open generated page reflects the committed source. Waits for pending
  persistence first, then recenters the viewport on the current selection
  (e.g. the just-created component) so the new content is on screen. Token
  resyncs pass {:recenter? false}: the user stays where they are and keeps
  reading the panorama while the other combination columns update.

  A newer re-projection cancels this one, and a snapshot that no longer
  matches the current revision is dropped, so results never land out of
  order."
  [{:keys [recenter?] :or {recenter? true}}]
  (ptk/reify ::reproject-generated-page
    ptk/WatchEvent
    (watch [_ state stream]
      (let [file-id    (:current-file-id state)
            undo-stack (get state :workspace-undo)]
        (when (and (enabled?) file-id)
          (let [swapped (->> (dps/wait-persisted 15000)
                             (rx/mapcat (fn [_]
                                          (reset! workspace-promise nil)
                                          (->> (workspace)
                                               (rx/from)
                                               (rx/filter #(current-projection? file-id %))
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
                             (rx/take-until
                              (rx/filter (ptk/type? ::reproject-generated-page) stream))
                             (rx/share))]
            (rx/merge
             (rx/mapcat (fn [event]
                          (if recenter?
                            (rx/of event (center-viewport-on-selection))
                            (rx/of event)))
                        swapped)
             (restore-undo-stack file-id undo-stack swapped stream))))))))

;; DSE-R26: canonical operations that change Token Cell values or the
;; project's active themes. When such a batch lands while a generated page
;; is open, bound content elsewhere on the board (the other combination
;; columns, alias displays, component and page occurrences) must resync.
(def ^:private token-operation-types
  #{"set-token-value" "set-active-token-themes" "replace-token-library"})

(defn save-acknowledgement
  "Translate a confirmed Package save into Penpot's numeric acknowledgement.
  The content hash remains the canonical revision for local concurrency."
  [response revn]
  (when-not (and (string? (:revision response))
                 (seq (:revision response)))
    (throw (ex-info "Local save response has no package revision"
                    {:type :persistence :code :invalid-save-response})))
  (assoc response :revn (inc (or revn 0))))

(defn- text-layout-change?
  "The renderer re-measures every text it lays out (on open, on a page
  switch, after a font loads) and saves the result as `position-data`.
  The Package derives text layout itself and stores none of it."
  [change]
  (and (= "mod-obj" (some-> (:type change) name))
       (seq (:operations change))
       (every? (fn [operation]
                 (and (= "set" (some-> (:type operation) name))
                      (= "position-data" (some-> (:attr operation) name))))
               (:operations change))))

(defn- no-op-change?
  "Changes the Package has nothing to write for, never sent: Penpot emits a
  `mov-objects` without shapes when a drag ends inside the shapes' own
  parent (the Background rejects an empty node move), and text layout
  measurements."
  [change]
  (or (and (= "mov-objects" (some-> (:type change) name))
           (empty? (:shapes change)))
      (text-layout-change? change)))

(defn- decoration-change?
  "Renderer bookkeeping on a Components page label: labels exist only in
  the projection, so the Package has nothing to write for them."
  [state change]
  (and (= "mod-obj" (some-> (:type change) name))
       (= "decoration"
          (-> (dsh/lookup-page state (:page-id change))
              (get-in [:objects (:id change) :plugin-data :smallpen "components-page"])))))

(defn- shape-layout-offset
  "The shift a generated page draws a source tree with (projection.cljs
  `with-layout-offset`), as {:x :y}."
  [shape]
  (when-let [value (get-in shape [:plugin-data :smallpen "layout-offset"])]
    (let [[x y] (map js/Number (str/split value #" "))]
      (when (and (js/isFinite x) (js/isFinite y))
        {:x x :y y}))))

(declare generated-page?)

(defn- tree-layout-offset
  "The layout offset of a shape's tree: its own, else the nearest
  ancestor's (a layer just added inside a variant main has none yet)."
  [objects id]
  (loop [id id]
    (when-let [shape (get objects id)]
      (or (shape-layout-offset shape)
          (when-not (= id (:parent-id shape))
            (recur (:parent-id shape)))))))

(def ^:private parent-geometry-keys
  [:x :y :width :height :rotation :transform :flip-x :flip-y :selrect])

(defn- variant-parent
  "On the Components page, the parent of an edited or added layer of a
  variant main as Penpot holds it now, and the layer itself. Mains move
  freely there (their place is not saved), so the adapter reads a layer's
  place against these, not against where the projection drew them."
  [page change]
  (when (true? (get-in page [:plugin-data :smallpen "components-page"]))
    (let [objects   (:objects page)
          shape     (get objects (:id change))
          parent-id (or (:parent-id shape) (:parent-id change))
          parent    (get objects parent-id)]
      (when (shape-layout-offset parent)
        (cond-> {:id parent-id
                 :geometry (select-keys parent parent-geometry-keys)}
          (some? shape)
          (assoc :child (select-keys shape parent-geometry-keys)))))))

(defn with-layout-offsets
  "Attach to each shape edit on a generated page the layout offset its tree
  is drawn with. Penpot reports that copy's page-absolute geometry; the
  adapter removes the offset to map the edit back to the source node. A
  shape added on the Components page (a layer in a variant main) takes its
  tree's offset, and edits there carry their parent's current geometry. A
  shape elsewhere can still carry an offset it inherited from a main, which
  means nothing there."
  [state changes]
  (mapv (fn [change]
          (let [type   (some-> (:type change) name)
                page   (when (contains? #{"mod-obj" "add-obj"} type)
                         (dsh/lookup-page state (:page-id change)))
                offset (cond
                         (not (generated-page? page))
                         nil

                         (= "mod-obj" type)
                         (-> (:objects page)
                             (get (:id change))
                             (shape-layout-offset))

                         (true? (get-in page [:plugin-data :smallpen "components-page"]))
                         (or (tree-layout-offset (:objects page) (:id change))
                             (tree-layout-offset (:objects page) (:parent-id change))))
                parent (when (some? offset) (variant-parent page change))]
            (cond-> change
              (some? offset) (assoc :smallpen-layout-offset offset)
              (some? parent) (assoc :smallpen-parent parent))))
        changes))

(defn- rejected-commit?
  "The Background refused the change itself (422): it can never be written
  to the Package. A stale revision (409) or a transport failure is not a
  rejection and keeps Penpot's own persistence handling."
  [cause]
  (let [{:keys [type status]} (ex-data cause)]
    (and (= :smallpen-backend type)
         (= 422 status))))

(defn- rejection-reason
  "Why the Background refused a change, in the user's language when the
  refusal is one a Penpot variant edit can run into."
  [cause]
  (case (some-> (:code (ex-data cause)) name)
    "variant_duplicate_selection" (tr "smallpen.variants.duplicate-selection")
    "variant_value_missing" (tr "smallpen.variants.value-missing")
    "variant_property_name_invalid" (tr "smallpen.variants.property-name-invalid")
    "variant_properties_mismatch" (tr "smallpen.variants.properties-mismatch")
    "variant_in_use" (tr "smallpen.variants.in-use")
    "variant_nested_instance_unsupported" (tr "smallpen.variants.nested-instance")
    "variant_outside_container" (tr "smallpen.variants.outside-container")
    "variant_container_content_unsupported" (tr "smallpen.variants.container-content")
    "component_page_shape_unsupported" (tr "smallpen.variants.page-shape")
    "duplicate_name" (tr "smallpen.save.duplicate-name" (str (get-in (ex-data cause) [:details :name])))
    (str (ex-message cause))))

(defn- drop-rejected-commit
  "Penpot halts autosave for the session after a failed save, so every
  later edit would be lost. A rejected change exists only locally: say so,
  and roll the workspace back to the Package so the next edits build on what
  was saved. Undo entries may target the dropped change, so history goes."
  [cause]
  (ptk/reify ::drop-rejected-commit
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (ntf/show
              {:content (tr "smallpen.save.change-rejected" (rejection-reason cause))
               :level :error
               :timeout 15000
               :type :toast})
             dwu/reinitialize-undo
             (reproject-generated-page {:recenter? false})))))

(defn- referenced-local-media
  "The pending `local-media` ids that `changes` refer to."
  [changes]
  (let [pending @local-media]
    (if (empty? pending)
      #{}
      (into #{}
            (filter #(and (uuid? %) (contains? pending %)))
            (tree-seq coll? seq changes)))))

(defn- remove-orphan-media
  "Penpot keeps a pasted or dropped image out of the library (`:is-local`),
  but a Package only has library Media. When the Background refuses the
  change that placed such an upload, nothing uses it any more: remove it so
  the failed paste leaves no library entry behind."
  [changes]
  (if-let [orphans (not-empty (referenced-local-media changes))]
    (->> (serialized-write
          #(post-json "/v1/penpot/commit"
                      {:baseRevision (:revision @workspace-state)
                       :changes (mapv (fn [id] {:type :del-media :id id}) orphans)
                       :commitId (str (uuid/next))}))
         (rx/from)
         (rx/tap (fn [response]
                   (swap! local-media #(reduce disj % orphans))
                   (update-revision! response)))
         (rx/map (constantly nil))
         (rx/catch (fn [cause]
                     (js/console.error "SmallPen could not remove unused Media" cause)
                     (rx/of nil))))
    (rx/of nil)))

(defn- reprojection-options
  "One refresh per save. Token changes preserve the viewport, including
  mixed batches. An explicit empty operation list confirms a canonical
  no-op; older Backgrounds that omit the field keep their sync behavior."
  [structural? generated? operation-types]
  (cond
    (= [] operation-types)
    nil

    (some token-operation-types operation-types)
    {:recenter? false}

    ;; A board dragged on a shared canvas reorders its business flow; the
    ;; canvas layout moves every board to its new slot.
    (some #{"put-canvases"} operation-types)
    {:recenter? false}

    (and structural? generated?)
    {}

    (and generated? (some #{"put-component-set"} operation-types))
    {:recenter? false}))

(defn- commit-workspace
  [{:keys [changes commit-id revn]}]
  (if-let [changes (not-empty (->> changes
                                   (into [] (comp (remove no-op-change?)
                                                  (remove (partial decoration-change? @st/state))))
                                   (with-layout-offsets @st/state)))]
    (let [{:keys [file-id]} @workspace-state
          structural? (boolean
                       (some #(contains? structural-change-types
                                         (name (or (:type %) %)))
                             changes))]
      (->> (serialized-write
            #(post-json "/v1/penpot/commit"
                        {:baseRevision (:revision @workspace-state)
                         :changes changes
                         :commitId (str commit-id)}))
           (rx/from)
           (rx/map #(save-acknowledgement % revn))
           ;; 切换文件后到达的旧响应不能污染新文件的修订状态。
           (rx/tap (fn [response]
                     (when (= file-id (:file-id @workspace-state))
                       (swap! local-media #(reduce disj % (referenced-local-media changes)))
                       (update-revision! response)
                       ;; Structural edits resync generated pages; component
                       ;; properties refresh their labels. Token edits resync
                       ;; bound content on screen pages too (DSE-R11/R26).
                       (when-let [options (reprojection-options
                                           structural? (generated-page-open?)
                                           (:operationTypes response))]
                         (st/async-emit! (reproject-generated-page options)))
                       ;; A name the edit repeated was numbered ("Card 2"):
                       ;; show the stored name and say so.
                       (when-let [renamed (seq (:renamed response))]
                         (st/async-emit!
                          (reproject-generated-page {:recenter? false})
                          (ntf/show
                           {:content (tr "smallpen.save.renamed"
                                         (str/join ", " (map (fn [{:keys [requested to]}] (str requested " → " to)) renamed)))
                            :level :info
                            :timeout 6000
                            :type :toast}))))))
           ;; Acknowledge a rejected change as a no-op save so the queue
           ;; moves on; the workspace drops it locally.
           (rx/catch (fn [cause]
                       (if (and (rejected-commit? cause)
                                (= file-id (:file-id @workspace-state)))
                         (->> (remove-orphan-media changes)
                              (rx/map (fn [_]
                                        (st/async-emit! (drop-rejected-commit cause))
                                        {:revision (:revision @workspace-state)
                                         :revn (or revn 0)})))
                         (rx/throw cause))))))
    (rx/of {:revision (:revision @workspace-state)
            :revn (or revn 0)})))

(defn- media-upload-headers
  "HTTP header values must be ISO-8859-1, so a file name such as 截图.png
  would make fetch throw. The name travels percent-encoded and the
  Background decodes it."
  [content name]
  #js {"content-type" (.-type content)
       "x-smallpen-media-name" (js/encodeURIComponent (or name ""))})

(defn media-object
  "Penpot reads a file media object's ids as uuids; the Background answers
  them as JSON strings."
  [value]
  (reduce (fn [value key] (d/update-when value key uuid/parse*))
          (dissoc value :revision)
          [:id :file-id :media-id :thumbnail-id]))

(defn- track-local-media
  "Remember an upload made for a shape (`:is-local`) until a saved change
  references it; see `remove-orphan-media`."
  [is-local media]
  (when (true? is-local)
    (swap! local-media conj (:id media)))
  media)

(defn- upload-media
  [{:keys [content name is-local]}]
  (when-not (instance? js/Blob content)
    (throw (ex-info "SmallPen Media upload requires a Blob"
                    {:type :validation
                     :code :invalid-media-blob})))
  (->> (serialized-write
        #(request "/v1/media/import"
                  #js {:method "POST"
                       :headers (media-upload-headers content name)
                       :body content}))
       (rx/from)
       (rx/tap update-revision!)
       (rx/map media-object)
       (rx/map (partial track-local-media is-local))))

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
  (->> (serialized-write #(post-json path params))
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

(defmethod rp/cmd! :get-environment-data
  [id params]
  (if (enabled?)
    ;; SmallPen is a local Package workspace. Returning no remote feature flags
    ;; keeps Penpot's official instrumentation lifecycle intact while preventing
    ;; it from starting telemetry/audit collection against a nonexistent server.
    ;; A failed request would make Penpot fall back to telemetry instead.
    (rx/of {:deployment "selfhost" :flags #{}})
    (fallback-command id params)))

(def ^:private satisfied-profile-props
  "First-run markers Penpot writes on its own. The local profile already
  reports every one of them as done, so there is nothing to persist."
  #{:onboarding-questions
    :onboarding-questions-answered
    :onboarding-team-id
    :onboarding-viewed
    :release-notes-viewed
    :v2-info-shown
    :workspace-visited})

(defn- unsupported-profile-props
  [props]
  (->> (keys props)
       (remove #(or (= :renderer %)
                    (contains? satisfied-profile-props %)))
       (sort)
       (seq)))

(defmethod rp/cmd! :update-profile-props
  [id params]
  (if (enabled?)
    (let [props (:props params)]
      (if-let [unsupported (unsupported-profile-props props)]
        (rx/throw (ex-info "SmallPen cannot store these profile properties"
                           {:type :restriction
                            :code :smallpen-unsupported-profile-props
                            :props (vec unsupported)}))
        (if-let [renderer (:renderer props)]
          (->> (post-json "/v1/preferences" {:renderer renderer})
               (rx/from)
               (rx/tap #(reset! workspace-promise nil)))
          (rx/of nil))))
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
         (rx/map media-object)
         (rx/map (partial track-local-media (:is-local params))))
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
      (js/alert (tr "smallpen.external.merge-failed")))))

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

(defn- begin-external-reconciliation!
  "Start reconciling with a Package revision written outside this workspace.
  The known revision stays the one local edits were made against: pending
  edits flush with that baseRevision, so the Background rejects a stale one
  (409) instead of writing it over the external change, and the rejection
  reaches the alert in `external-reconciliation-timeout`. The new revision
  is adopted only by the reload, from a fresh snapshot. False when a
  reconciliation is already running."
  []
  (when (compare-and-set! external-reconciliation? false true)
    (reset! workspace-promise nil)
    true))

(defn- reconcile-external-change!
  []
  (when (begin-external-reconciliation!)
    (st/emit! (freeze-for-external-reconciliation)
              (dwc/set-workspace-read-only true)
              (persist-before-external-reload))))

(defn- note-history-cleared!
  "The Background dropped its local Undo/Redo with an external revision:
  every entry targets content that no longer exists. Penpot's stack is
  cleared too. When it offered anything, the notice is staged in
  sessionStorage so it survives the reconciliation reload; the Background
  history may come from an earlier window this one never showed."
  [session-id]
  (when (seq (get-in @st/state [:workspace-undo :items]))
    (some-> (session-storage) (.setItem history-cleared-key session-id)))
  (st/emit! dwu/reinitialize-undo))

(defn- foreign-write?
  "Resolves true when a write announced with `revision` came from another
  window on the same Package session. This window's own writes are
  announced the same way, sometimes before their response arrives, so the
  answer waits for the writes in flight to settle."
  [revision]
  (.then @write-queue
         (fn [_]
           (not (or (= revision (:revision @workspace-state))
                    (some #{revision} @own-revisions))))))

(defn- handle-event!
  [message]
  (let [type       (unchecked-get message "type")
        session-id (unchecked-get message "sessionId")
        current?   (= session-id (:package-session-id @workspace-state))]
    (case type
      "external-revision"
      (when current?
        (when (true? (unchecked-get message "historyCleared"))
          (note-history-cleared! session-id))
        (reconcile-external-change!))
      "external-recovered"
      (when current?
        (reconcile-external-change!))
      ("package-committed" "package-undone" "package-redone")
      (when current?
        (.then (foreign-write? (unchecked-get message "revision"))
               #(when % (reconcile-external-change!))))
      "package-dependency-changed"
      (when current?
        (reconcile-external-change!))
      "invalid-external-state"
      (when current?
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
          {:content (tr "smallpen.external.invalid-package")
           :level :error
           :timeout 30000
           :type :toast}))
        (js/console.error "SmallPen package is invalid; keeping the last valid workspace read-only"))
      nil)))

(defn- start-events!
  []
  (some-> @event-source (.close))
  (let [source (js/EventSource. (endpoint "/v1/events"))]
    (set! (.-onmessage source)
          (fn [event]
            (handle-event! (js/JSON.parse (.-data event)))))
    (reset! event-source source)))

(defn runtime-options
  "Only the SmallPen web host injects `smallpenRuntime`. Without it this
  bundle is an ordinary Penpot deployment and the URL parameters are
  ignored, so a crafted link cannot switch it into SmallPen mode."
  ([href]
   (runtime-options href (unchecked-get js/globalThis "smallpenRuntime")))
  ([href runtime]
   (if-not runtime
     {}
     (let [url              (js/URL. href)
           parameters       (.-searchParams url)
           route-query      (some-> (.-hash url)
                                    (str/split #"\?" 2)
                                    (second))
           route-parameters (js/URLSearchParams. (or route-query ""))
           backend          (some-> (or (unchecked-get runtime "backendUrl")
                                        (.get parameters "smallpen-backend"))
                                    (str/replace #"/$" ""))
           package          (or (unchecked-get runtime "packageSessionId")
                                (.get parameters "smallpen-package"))
           file-id          (or (.get parameters "file-id")
                                (.get route-parameters "file-id"))]
       (cond-> {}
         (seq backend) (assoc :backend-url backend)
         (seq package) (assoc :package-session-id package)
         (seq file-id) (assoc :file-id file-id))))))

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
  persistence (for example a token import). Reconcile exactly like an
  external change: pending edits keep their original baseRevision, so a
  stale one is rejected instead of overwriting the write, and the reload
  picks up the new revision."
  []
  (reset! workspace-promise nil)
  (reconcile-external-change!))

(defn current-revision
  "The Package revision the open workspace was projected from."
  []
  (:revision @workspace-state))

(defn persist-pending-edits!
  "Flush queued local edits. Resolves once they are saved; rejects when they
  cannot be, so a caller never builds on a revision that is about to move."
  []
  (js/Promise.
   (fn [resolve reject]
     (st/emit! ::dps/force-persist)
     (->> (dps/wait-persisted-or-error 15000)
          (rx/take 1)
          (rx/subs! resolve reject #(resolve nil))))))
