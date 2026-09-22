;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.dse-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.common :as dcm]
   [app.main.data.workspace.drawing :as drawing]
   [app.main.data.workspace.edition :as edition]
   [app.main.data.workspace.media :as media]
   [app.main.smallpen.dse :as dse]
   [app.main.smallpen.edit-policy :as policy]
   [app.util.storage :as storage]
   [beicon.v2.core :as rx]
   [cljs.test :as t]
   [potok.v2.core :as ptk]))

(def page-id  #uuid "a1e50000-0000-4000-8000-000000000001")
(def frame-id #uuid "a1e50000-0000-4000-8000-000000000002")
(def component-id #uuid "a1e50000-0000-4000-8000-000000000003")

(defn- file-with
  [{:keys [components can-edit page-plugin-data frames?]
    :or {components {} can-edit true page-plugin-data {} frames? true}}]
  {:data
   {:pages [page-id]
    :pages-index
    {page-id
     {:id page-id
      :name "Home"
      :plugin-data {:smallpen page-plugin-data}
      :objects (merge
                {uuid/zero
                 {:id uuid/zero
                  :name "Root"
                  :shapes (when frames? [frame-id])
                  :type :frame}}
                (when frames?
                  {frame-id
                   {:id frame-id
                    :name "Sheet"
                    :shapes []
                    :type :frame}}))}
    }
    :components components}
   :permissions {:can-edit can-edit}})

(def generated-page-plugin-data
  {"design-system-page" true})

(defn- emitted-commits
  [file changes]
  (let [file-id (uuid/next)
        events (atom [])
        state {:current-file-id file-id :current-page-id page-id
               :permissions {:can-edit true} :features #{}
               :files {file-id (assoc file :revn 0 :vern 0)}}]
    (rx/subs! #(swap! events conj %)
              (ptk/watch (dch/commit-changes {:redo-changes changes :undo-changes []})
                         state (rx/empty)))
    (filter dch/commit? @events)))

(t/deftest ds-structure-is-rejected-before-local-commit
  (let [file (file-with {:page-plugin-data generated-page-plugin-data})
        deletion {:type :del-obj :page-id page-id :id frame-id}]
    (t/is (empty? (emitted-commits file [deletion])))
    (t/is (= 1 (count (emitted-commits (file-with {}) [deletion])))
          "ordinary source pages stay editable")))

(t/deftest ds-policy-preserves-source-edits-and-rejects-structure
  (let [file (-> (file-with {:page-plugin-data generated-page-plugin-data})
                 (assoc-in [:data :pages-index page-id :objects frame-id :plugin-data]
                           {:smallpen {"design-system" "source"}}))
        modify (fn [attr val]
                 {:type :mod-obj :page-id page-id :id frame-id
                  :operations [{:type :set :attr attr :val val}]})
        opacity (modify :opacity 0.5)]
    (doseq [change [(modify :opacity 0.5) (modify :width 120)
                    (modify :r1 8) (modify :token-value "#ffffff")]]
      (t/is (nil? (policy/commit-block-reason file [change]))))
    (t/is (= 1 (count (emitted-commits file [opacity]))))
    (doseq [type [:add-obj :del-obj :mov-objects :reorder-children :mod-page :del-page]]
      (t/is (= :structure (policy/commit-block-reason
                          file [{:type type :id frame-id :page-id page-id}]))))
    (t/is (= :structure (policy/commit-block-reason file [(modify :layout :flex)])))
    (t/is (= :position (policy/commit-block-reason file [(modify :x 100)])))
    (t/is (nil? (policy/commit-block-reason
                 file [(update (modify :width 120) :operations conj
                               {:type :set :attr :x :val 100})]))
          "resizing may include an accompanying position update")
    (t/is (empty? (emitted-commits file [opacity {:type :del-obj :page-id page-id :id frame-id}]))
          "reject a mixed action atomically before it can enter persistence")
    (t/is (= 1 (count (emitted-commits file [opacity])))
          "a rejected action does not poison the next valid edit")
    (t/is (nil? (policy/commit-block-reason
                 file [{:type :add-obj :page-id (uuid/next) :id (uuid/next)}]))
          "explicit creation in a source page is not blocked")
    (t/is (= :structure (policy/commit-block-reason file [{:type :del-page :id page-id}])))))

(t/deftest ds-decoration-edits-never-enter-persistence
  (let [file (file-with {:page-plugin-data generated-page-plugin-data})
        change {:type :mod-obj :page-id page-id :id frame-id
                :operations [{:type :set :attr :fills :val []}]}]
    (t/is (= :decoration (policy/commit-block-reason file [change])))
    (t/is (empty? (emitted-commits file [change])))
    (t/is (nil? (policy/commit-block-reason
              file [(assoc change :operations [{:type :set :attr :position-data :val []}])
                    {:type :reg-objects :page-id page-id :shapes [frame-id]}])))
    (t/is (nil? (policy/commit-block-reason (file-with {}) [change])))))

(t/deftest ds-blocks-drawing-and-decoration-text-editing-at-entry
  (let [file-id (uuid/next)
        file (file-with {:page-plugin-data generated-page-plugin-data})
        state {:current-file-id file-id :current-page-id page-id
               :files {file-id file}}
        ordinary (assoc-in state [:files file-id] (file-with {}))]
    (doseq [tool [:rect :frame :text :path :circle :curve :line :arrow]]
      (t/is (nil? (get-in (ptk/update (drawing/select-for-drawing tool) state)
                          [:workspace-drawing :tool])))
      (t/is (= tool (get-in (ptk/update (drawing/select-for-drawing tool) ordinary)
                            [:workspace-drawing :tool]))))
    (t/is (nil? (get-in (ptk/update (drawing/start-drawing :rect) state)
                        [:workspace-drawing :lock])))
    (t/is (nil? (get-in (ptk/update (edition/start-edition-mode frame-id) state)
                        [:workspace-local :edition])))
    (t/is (= frame-id (get-in (ptk/update (edition/start-edition-mode frame-id) ordinary)
                              [:workspace-local :edition])))))

(t/deftest ds-rejects-image-drop-before-uploading-assets
  (let [file-id (uuid/next)
        state {:current-file-id file-id :current-page-id page-id
               :files {file-id (file-with {:page-plugin-data generated-page-plugin-data})}}
        events (atom [])]
    (rx/subs! #(swap! events conj %)
              (ptk/watch (media/upload-media-workspace {:file-id file-id :blobs []})
                         state (rx/empty)))
    (t/is (= 1 (count @events)))
    (t/is (= :app.main.data.notifications/show (ptk/type (first @events))))))

(t/deftest insert-panel-state-allows-creating-the-first-component
  (let [file  (file-with {})
        state (dse/insert-panel-state file {:plugin-data {:smallpen generated-page-plugin-data}})]
    (t/is (:visible? state))
    (t/is (nil? (:reason state)))
    (t/is (:can-create? state))
    (t/is (not (:can-insert? state)))))

(t/deftest insert-panel-state-gates-inserting-on-available-components
  (let [file  (file-with {:components {component-id {:id component-id :name "Button"}}})
        state (dse/insert-panel-state file {:plugin-data {:smallpen generated-page-plugin-data}})]
    (t/is (:visible? state))
    (t/is (:can-create? state))
    (t/is (:can-insert? state))))

(t/deftest insert-panel-state-explains-read-only-packages
  (let [file  (file-with {:can-edit false})
        state (dse/insert-panel-state file {:plugin-data {:smallpen generated-page-plugin-data}})]
    (t/is (:visible? state))
    (t/is (= :read-only (:reason state)))
    (t/is (not (:can-create? state)))
    (t/is (not (:can-insert? state)))))

(t/deftest insert-panel-state-explains-missing-containers
  (let [file  (file-with {:frames? false})
        state (dse/insert-panel-state file {:plugin-data {:smallpen generated-page-plugin-data}})]
    (t/is (:visible? state))
    (t/is (= :no-container (:reason state)))
    (t/is (not (:can-create? state)))
    (t/is (not (:can-insert? state)))))

(t/deftest insert-panel-state-hides-off-the-design-system-page
  (let [file  (file-with {})
        state (dse/insert-panel-state file {:plugin-data {}})]
    (t/is (not (:visible? state)))
    (t/is (not (:can-create? state)))))

(t/deftest writable-containers-exclude-generated-pages
  (let [file (file-with {:page-plugin-data generated-page-plugin-data})]
    (t/is (= [] (dse/writable-containers file))))
  (let [file    (file-with {})
        targets (dse/writable-containers file)]
    (t/is (= #{frame-id} (into #{} (map :container-id) targets)))
    (t/is (= page-id (:page-id (first targets))))))

(t/deftest design-system-board-fit-is-only-requested-without-a-valid-viewport
  (let [file-id  #uuid "a1e50000-0000-4000-8000-000000000004"
        board-id #uuid "a1e50000-0000-4000-8000-000000000005"
        valid-local {:zoom 0.75
                     :vbox {:x -20 :y 10 :width 1200 :height 800}}]
    (t/is (= board-id
             (dcm/initial-workspace-board-id {} file-id page-id board-id true))
          "first entry requests a fit to the generated board")
    (t/is (nil? (dcm/initial-workspace-board-id
                 {:workspace-cache {[file-id page-id] valid-local}}
                 file-id page-id board-id true))
          "reopening restores the cached viewport instead of fitting again")
    (t/is (= board-id
             (dcm/initial-workspace-board-id
              {:workspace-cache {[file-id page-id] valid-local}}
              file-id page-id board-id false))
          "ordinary workspace navigation preserves an explicit board target")
    (t/is (= board-id
             (dcm/initial-workspace-board-id
              {:workspace-cache {[file-id page-id]
                                  {:zoom 0 :vbox {:width 0 :height 0}}}}
              file-id page-id board-id true))
          "an invalid cached viewport falls back to the initial fit")))

(t/deftest design-system-viewport-survives-a-browser-state-restart
  (let [file-id  #uuid "a1e50000-0000-4000-8000-000000000004"
        board-id #uuid "a1e50000-0000-4000-8000-000000000005"
        local    {:zoom 0.75
                  :vbox {:x -20 :y 10 :width 1200 :height 800}}
        file     (file-with {:page-plugin-data generated-page-plugin-data})
        before   @storage/session]
    (try
      (dcm/persist-current-workspace-viewport!
       {:current-file-id file-id
        :current-page-id page-id
        :files {file-id file}
        :workspace-local local})
      (let [restarted (ptk/update
                       (dcm/go-to-workspace :file-id file-id
                                            :page-id page-id
                                            :board-id board-id
                                            :design-system? true)
                       {})]
        (t/is (= local (get-in restarted [:workspace-cache [file-id page-id]])))
        (t/is (nil? (dcm/initial-workspace-board-id
                     restarted file-id page-id board-id true))))
      (finally
        (reset! storage/session before)))))

(t/deftest ordinary-workspaces-do-not-read-or-write-design-system-viewports
  (let [file-id  #uuid "a1e50000-0000-4000-8000-000000000006"
        local    {:zoom 0.5
                  :vbox {:x 1 :y 2 :width 900 :height 600}}
        before   @storage/session]
    (try
      (dcm/persist-current-workspace-viewport!
       {:current-file-id file-id
        :current-page-id page-id
        :files {file-id (file-with {})}
        :workspace-local local})
      (let [restarted (ptk/update
                       (dcm/go-to-workspace :file-id file-id
                                            :page-id page-id)
                       {})]
        (t/is (nil? (get-in restarted [:workspace-cache [file-id page-id]]))
              "an ordinary route must not hydrate SmallPen session state")
        (t/is (nil? (get-in @storage/session
                            [::dcm/workspace-viewports [file-id page-id]]))
              "pagehide persistence must ignore an ordinary workspace"))
      (finally
        (reset! storage/session before)))))
