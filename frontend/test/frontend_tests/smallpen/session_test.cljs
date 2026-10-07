;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.session-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.event :as ev]
   [app.main.data.persistence :as dps]
   [app.main.data.workspace.common :as dwc]
   [app.main.refs :as refs]
   [app.main.repo :as rp]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as session]
   [app.main.smallpen.token-import :as token-import]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cljs.test :as t]
   [clojure.string :as str]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.http :as http]
   [frontend-tests.helpers.mock :as mock]
   [frontend-tests.smallpen.projection-test :as fixture]
   [potok.v2.core :as ptk]))

(t/deftest local-save-acknowledgement-satisfies-native-persistence
  (let [response {:revision "package-content-hash" :operationTypes ["set-token-value"]}
        result (smallpen/save-acknowledgement response 7)]
    (t/is (= 8 (:revn result)))
    (t/is (= response (dissoc result :revn))))
  (t/is (= 1 (:revn (smallpen/save-acknowledgement {:revision "first-save"} nil))))
  (doseq [response [{} {:revision nil} {:revision ""}]]
    (t/is (thrown? js/Error (smallpen/save-acknowledgement response 7)))))

(t/deftest local-session-satisfies-the-penpot-workspace-shell
  (let [profile (session/profile fixture/snapshot)
        team    (session/team fixture/snapshot)
        project (session/project fixture/snapshot)
        member  (session/member fixture/snapshot)]
    (t/is (= session/local-team-id (:default-team-id profile)))
    (t/is (= fixture/project-id (:default-project-id profile)))
    (t/is (= :svg (get-in profile [:props :renderer])))
    (t/is (true? (get-in profile [:props :workspace-visited])))
    (t/is (= session/local-team-id (:id team)))
    (t/is (true? (get-in team [:permissions :can-edit])))
    (t/is (not (contains? (:features team) "render-wasm/v1")))
    (t/is (= session/local-team-id (:team-id project)))
    (t/is (= (:id profile) (:id member)))
    (t/is (= :owner (:role member)))))

(t/deftest local-session-resolves-the-default-canvas-page
  (t/is (= fixture/page-id (session/default-page-id fixture/snapshot))))

(t/deftest local-session-builds-the-prototype-viewer-bundle
  (let [file        (:file (projection/project-snapshot
                            fixture/snapshot
                            {:file-id fixture/file-id
                             :project-id fixture/project-id}))
        bundle      (session/viewer-bundle fixture/snapshot file)
        permissions (:permissions bundle)]
    (t/is (= fixture/file-id (get-in bundle [:file :id])))
    (t/is (= fixture/project-id (get-in bundle [:project :id])))
    (t/is (= session/local-team-id (get-in bundle [:team :id])))
    (t/is (= permissions (get-in bundle [:team :permissions])))
    (t/is (true? (:can-read permissions)))
    (t/is (= 1 (count (:users bundle))))
    (t/is (= [] (:libraries bundle)))
    (t/is (= {} (:thumbnails bundle)))))

(t/deftest local-session-exposes-invalid-packages-as-read-only
  (let [snapshot (assoc fixture/snapshot :packageStatus {:readOnly true})]
    (t/is (false? (get-in (session/team snapshot)
                          [:permissions :can-edit])))
    (t/is (false? (get-in (session/member snapshot)
                          [:permissions :can-edit])))
    (t/is (false? (get-in (projection/project-snapshot
                           snapshot
                           {:file-id fixture/file-id
                            :project-id fixture/project-id})
                          [:file :permissions :can-edit])))))

(t/deftest external-reconciliation-freezes-new-edits-but-allows-pending-persistence
  (let [state  {:permissions {:can-edit true}
                :workspace-global {:read-only? false}}
        result (->> state
                    (ptk/update
                     (#'smallpen/freeze-for-external-reconciliation))
                    (ptk/update (dwc/set-workspace-read-only true)))]
    (t/is (false? (get-in result [:permissions :can-edit])))
    (t/is (true? (get-in result [:workspace-global :read-only?])))
    (t/is (true? (get-in result [:workspace-global
                                 :persist-pending-while-read-only?])))
    (t/is (true? (#'dps/persistence-allowed? result)))))

(t/deftest queued-edits-survive-ui-read-only-but-not-permission-loss
  (t/is (true? (#'dps/persistence-allowed?
                {:permissions {:can-edit true}
                 :workspace-global {:read-only? true}})))
  (t/is (false? (#'dps/persistence-allowed?
                 {:permissions {:can-edit false}
                  :workspace-global {:read-only? false}})))
  (t/is (true? (#'dps/persistence-allowed?
                {:permissions {:can-edit true}
                 :workspace-global {:read-only? false}}))))

(t/deftest local-session-profile-uses-application-preferences
  (let [profile (session/profile
                 (assoc fixture/snapshot
                        :preferences {:language "zh_hant"
                                      :theme "system"}))]
    (t/is (= "zh_hant" (:lang profile)))
    (t/is (= "system" (:theme profile)))))

(t/deftest local-session-can-bootstrap-before-a-package-is-selected
  (let [snapshot (session/home-snapshot {:language "zh_cn"
                                         :renderer "svg"
                                         :theme "dark"})
        profile  (session/profile snapshot)
        project  (session/project snapshot)]
    (t/is (= session/local-project-id (:default-project-id profile)))
    (t/is (= session/local-project-id (:id project)))
    (t/is (= session/local-team-id (:team-id project)))
    (t/is (= [] (session/font-variants snapshot)))))

;; Scenario: a Package imported by an earlier release stored variant names
;; derived from weight and style. Penpot names those variants itself.
(t/deftest generated-font-variant-names-use-penpot-display-names
  (let [names    ["normal-400" "italic-700" "Italic 700" "400" "Condensed" nil]
        variants (map-indexed (fn [index name]
                                {:id (str "v" index) :name name
                                 :style "normal" :weight "400" :files {}})
                              names)
        snapshot {:manifest {:entries {:assets ["assets.json"]}}
                  :entries {"assets.json"
                            {:fonts [{:id "font_a" :family "Inter" :variants variants}]}}
                  :runtime {:fonts {:font_a (str (uuid/next))}
                            :fontFiles (into {}
                                             (map (fn [{:keys [id]}]
                                                    [(keyword id) {:woff (str (uuid/next))}]))
                                             variants)
                            :fontVariants (into {}
                                                (map (fn [{:keys [id]}]
                                                       [(keyword id) (str (uuid/next))]))
                                                variants)}}]
    (t/is (= [nil nil nil nil "Condensed" nil]
             (mapv :variant-name (session/font-variants snapshot))))))

(t/deftest smallpen-runtime-capabilities-default-local-only-features-off
  ;; Without a SmallPen backend, upstream Penpot/OpenPencil behavior is unchanged.
  (t/is (true? (smallpen/capability-enabled? :mcp)))
  (t/is (= {:ai-chat false
            :comments false
            :mcp false
            :plugins false
            :presence false
            :realtime-collaboration false
            :remote-history false}
           smallpen/default-capability-profile)))

(t/deftest smallpen-runtime-options-select-the-background-and-independent-package
  (t/is (= {:backend-url "http://127.0.0.1:43127/session"
            :package-session-id "package-2"}
           (smallpen/runtime-options
            "http://127.0.0.1:43128/?smallpen-backend=http%3A%2F%2F127.0.0.1%3A43127%2Fsession%2F&smallpen-package=package-2#/workspace"
            #js {}))))

(t/deftest smallpen-runtime-options-read-the-query-route
  (t/is (= {:backend-url "http://127.0.0.1:43130"
            :file-id "file-query"}
           (smallpen/runtime-options
            "http://localhost/?screen=workspace&file-id=file-query&smallpen-backend=http%3A%2F%2F127.0.0.1%3A43130"
            #js {}))))

(t/deftest smallpen-runtime-options-ignore-url-parameters-without-the-host-runtime
  ;; Only the SmallPen web host injects smallpenRuntime; a crafted link must
  ;; not switch an ordinary Penpot deployment into SmallPen mode.
  (t/is (= {}
           (smallpen/runtime-options
            "http://localhost/?file-id=file-query&smallpen-backend=http%3A%2F%2Fevil.test&smallpen-package=p"
            nil)))
  (t/is (= {}
           (smallpen/runtime-options
            "http://localhost/?smallpen-backend=http%3A%2F%2Fevil.test"))))

(t/deftest smallpen-runtime-options-read-the-file-from-the-penpot-route
  (t/is (= {:backend-url "http://127.0.0.1:43127/session"
            :file-id "502b4555-3f5f-807a-8008-8b9c3086ac46"}
           (smallpen/runtime-options
            "http://127.0.0.1:43128/#/workspace?file-id=502b4555-3f5f-807a-8008-8b9c3086ac46"
            #js {:backendUrl "http://127.0.0.1:43127/session/"}))))

(t/deftest smallpen-runtime-identifies-the-native-desktop-shell
  (t/is (true? (smallpen/desktop-runtime? #js {:desktop true})))
  (t/is (false? (smallpen/desktop-runtime? #js {:desktop false})))
  (t/is (= "smallpen://create"
           (smallpen/desktop-action-url "create")))
  (t/is (= "smallpen://open"
           (smallpen/desktop-action-url "open"))))

(t/deftest selecting-a-file-starts-with-an-isolated-package-state
  (t/is (= {:file-id "aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa"}
           (#'smallpen/selected-file-state fixture/file-id))))

(t/deftest direct-assets-prefer-the-stable-file-selector
  (t/is (= ["file-id" "file-2"]
           (#'smallpen/package-selector
            {:file-id "file-2" :package-session-id "stale-session"})))
  (t/is (= ["package" "package-2"]
           (#'smallpen/package-selector {:package-session-id "package-2"}))))

;; --- SmallPen runtime state fixtures --------------------------------------

(defn- runtime-atoms
  []
  {:backend     @#'smallpen/backend-url
   :workspace   @#'smallpen/workspace-state
   :reconciling @#'smallpen/external-reconciliation?
   :local-media @#'smallpen/local-media
   :own-revs    @#'smallpen/own-revisions})

(defn- enter-smallpen!
  "Point the SmallPen adapter at a fake Background with the given workspace
  state. Returns a thunk that restores the previous runtime state."
  [workspace-state]
  (let [atoms    (runtime-atoms)
        previous (update-vals atoms deref)]
    (reset! (:backend atoms) "http://background.test")
    (reset! (:workspace atoms) workspace-state)
    (reset! (:reconciling atoms) false)
    (reset! (:local-media atoms) #{})
    (reset! (:own-revs atoms) [])
    (fn []
      (doseq [[key value] previous]
        (reset! (get atoms key) value)))))

(defn- json-response
  [status body]
  (js/Response. (js/JSON.stringify (clj->js body))
                #js {:status status
                     :headers #js {"content-type" "application/json"}}))

;; Scenario: an external revision arrives while local edits are queued. The
;; queued edit flushes against the revision it was made on, the Background
;; rejects it as stale (409), and the rejection reaches the caller instead
;; of the edit silently landing on top of the external change.
(t/deftest pending-edits-keep-their-base-revision-across-an-external-change
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          bodies     (atom [])
          prev-fetch (http/install-fetch-mock!
                      (fn [_url opts]
                        (swap! bodies conj (js/JSON.parse (.-body opts)))
                        (js/Promise.resolve
                         (json-response 409 {:error {:code "stale_revision"
                                                     :message "stale"}}))))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))]
      (t/is (true? (#'smallpen/begin-external-reconciliation!)))
      (t/is (not (#'smallpen/begin-external-reconciliation!))
            "a second notice joins the running reconciliation")
      (t/is (= "rev-local" (:revision @@#'smallpen/workspace-state)))
      (->> (#'smallpen/commit-workspace
            {:changes [{:type :mod-obj :id (uuid/next) :operations []}]
             :commit-id (uuid/next)
             :revn 3})
           (rx/subs!
            (fn [_]
              (t/is false "a stale edit must not be acknowledged")
              (finish))
            (fn [cause]
              (t/is (= 409 (:status (ex-data cause))))
              (t/is (= :stale_revision (:code (ex-data cause))))
              (t/is (= ["rev-local"]
                       (mapv #(unchecked-get % "baseRevision") @bodies)))
              (t/is (= "rev-local" (:revision @@#'smallpen/workspace-state)))
              (finish)))))))

;; Scenario: a drag that ends inside the shape's own parent makes Penpot add
;; a `mov-objects` without shapes. Penpot applies it as a no-op; it must not
;; reach the Background, which rejects an empty node move and so fails the
;; whole save.
(t/deftest empty-node-moves-are-not-sent
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          bodies     (atom [])
          prev-fetch (http/install-fetch-mock!
                      (fn [_url opts]
                        (swap! bodies conj (js/JSON.parse (.-body opts)))
                        (js/Promise.resolve
                         (json-response 409 {:error {:code "stale_revision"
                                                     :message "stale"}}))))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))
          empty-move {:type :mov-objects :parent-id (uuid/next) :shapes []}]
      (->> (#'smallpen/commit-workspace
            {:changes [empty-move] :commit-id (uuid/next) :revn 2})
           (rx/subs!
            (fn [ack]
              (t/is (= {:revision "rev-local" :revn 2} ack))
              (t/is (empty? @bodies) "a no-op save sends nothing"))))
      (->> (#'smallpen/commit-workspace
            {:changes [{:type :mod-obj :id (uuid/next) :operations []}
                       empty-move]
             :commit-id (uuid/next)
             :revn 3})
           (rx/subs!
            (fn [_]
              (t/is false "the mocked Background rejects every save")
              (finish))
            (fn [_]
              (t/is (= [["mod-obj"]]
                       (mapv #(mapv (fn [change] (unchecked-get change "type"))
                                    (unchecked-get % "changes"))
                             @bodies)))
              (finish)))))))

;; Scenario: opening a page makes the renderer measure every text and save
;; the result as `position-data`. The Package stores no text layout, so a
;; save holding only measurements sends nothing; a real text edit that
;; carries its measurement along is still sent.
(t/deftest text-layout-measurements-are-not-sent
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          bodies     (atom [])
          prev-fetch (http/install-fetch-mock!
                      (fn [_url opts]
                        (swap! bodies conj (js/JSON.parse (.-body opts)))
                        (js/Promise.resolve
                         (json-response 409 {:error {:code "stale_revision"
                                                     :message "stale"}}))))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))
          measured   {:type :set :attr :position-data :val [{:text "Hi"}]
                      :ignore-geometry true :ignore-touched true}
          layout     {:type :mod-obj :id (uuid/next) :page-id (uuid/next)
                      :operations [measured]}]
      (->> (#'smallpen/commit-workspace
            {:changes [layout layout] :commit-id (uuid/next) :revn 2})
           (rx/subs!
            (fn [ack]
              (t/is (= {:revision "rev-local" :revn 2} ack))
              (t/is (empty? @bodies) "a measurement-only save sends nothing"))))
      (->> (#'smallpen/commit-workspace
            {:changes [layout
                       (assoc layout :operations
                              [{:type :set :attr :content :val {}} measured])]
             :commit-id (uuid/next)
             :revn 3})
           (rx/subs!
            (fn [_]
              (t/is false "the mocked Background rejects every save")
              (finish))
            (fn [_]
              (t/is (= [[["content" "position-data"]]]
                       (mapv #(mapv (fn [change]
                                      (mapv (fn [op] (unchecked-get op "attr"))
                                            (unchecked-get change "operations")))
                                    (unchecked-get % "changes"))
                             @bodies)))
              (finish)))))))

;; Scenario: a theme switch on a screen page. Token bindings resolve in the
;; Background, so the saved selection re-projects the open file wherever
;; the user is, not only on the generated Design System page.
(t/deftest a-saved-theme-switch-re-projects-the-open-file
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          emitted    (atom [])
          prev-emit  st/async-emit!
          prev-fetch (http/install-fetch-mock!
                      (fn [_url _opts]
                        (js/Promise.resolve
                         (json-response 200 {:revision "rev-dark"
                                             :operationTypes ["set-active-token-themes"]}))))
          finish     (fn []
                       (set! st/async-emit! prev-emit)
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))]
      (set! st/async-emit! (fn [& events] (swap! emitted into events)))
      (->> (#'smallpen/commit-workspace
            {:changes [{:type :set-tokens-status
                        :theme-ids [(uuid/next)]
                        :set-ids []}]
             :commit-id (uuid/next)
             :revn 1})
           (rx/subs!
            (fn [_]
              (t/is (some #(= ::smallpen/reproject-generated-page (ptk/type %))
                          @emitted))
              (finish))
            (fn [cause]
              (t/is false (str "the save must succeed: " (ex-message cause)))
              (finish)))))))

(t/deftest save-refreshes-preserve-the-viewport-and-older-backgrounds
  (doseq [[structural? generated? operations expected]
          [[false true ["put-component-set" "replace-token-library"] {:recenter? false}]
           [true true ["update-component-node" "set-token-value"] {:recenter? false}]
           [true true ["update-component-node"] {}]
           [true true [] nil]
           [true true nil {}]
           [true false ["update-node"] nil]
           [false false ["set-active-token-themes"] {:recenter? false}]]]
    (t/is (= expected (#'smallpen/reprojection-options structural? generated? operations)))))

(t/deftest ^:async saved-batches-refresh-the-generated-file-only-once
  (doseq [{:keys [label operations changes expected-count]}
          [{:label "Component and Token edits share one projection"
            :operations ["put-component-set" "replace-token-library"]
            :changes [{:type :mod-obj :id (uuid/next) :operations []}]
            :expected-count 1}
           {:label "Object registration without canonical operations leaves the file in place"
            :operations []
            :changes [{:type :reg-objects :shapes []}]
            :expected-count 0}
           {:label "Geometry edits still resync other component occurrences"
            :operations ["update-component-node"]
            :changes [{:type :mod-obj :id (uuid/next) :operations []}
                      {:type :reg-objects :shapes []}]
            :expected-count 1}]]
    (let [restore (enter-smallpen! {:file-id (str fixture/file-id) :revision "rev-local"})
          emitted (atom [])
          state {:current-file-id fixture/file-id
                 :current-page-id fixture/page-id
                 :files {fixture/file-id
                         {:data {:pages-index
                                 {fixture/page-id
                                  {:plugin-data {:smallpen {"components-page" true}}}}}}}}]
      (try
        (await
         (mock/with-mocks*
           {st/state (atom state)
            st/async-emit! (fn [& events] (swap! emitted into events))
            js/fetch (fn [_url _opts]
                       (js/Promise.resolve
                        (json-response 200 {:revision "rev-saved"
                                            :operationTypes operations})))}
           (await (async/observe
                   (#'smallpen/commit-workspace
                    {:changes (mapv #(assoc % :page-id fixture/page-id) changes)
                     :commit-id (uuid/next) :revn 1})))
           (t/is (= expected-count
                    (count (filter #(= ::smallpen/reproject-generated-page (ptk/type %))
                                   @emitted)))
                 label)))
        (finally (restore))))))

;; Scenario: the Background refuses one change (422). Penpot's persistence
;; would park in :error and never send a later edit, so the refusal is
;; acknowledged as a no-op save, the workspace drops the change and says so,
;; and the next edit saves normally.
(t/deftest a-rejected-change-is-dropped-without-halting-later-saves
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          responses  (atom [(json-response 422 {:error {:code "unsupported_penpot_attribute"
                                                        :message "Cannot compile foo"}})
                            (json-response 200 {:revision "rev-next"})])
          prev-fetch (http/install-fetch-mock!
                      (fn [url _opts]
                        (if (str/includes? url "/v1/penpot/commit")
                          (let [response (first @responses)]
                            (swap! responses rest)
                            (js/Promise.resolve response))
                          ;; The roll-back re-projection; out of scope here.
                          (js/Promise. (fn [_ _])))))
          dropped    (atom [])
          sub        (->> st/stream
                          (rx/filter (ptk/type? :app.main.smallpen/drop-rejected-commit))
                          (rx/subs! #(swap! dropped conj %)))
          commit     (fn [revn]
                       (#'smallpen/commit-workspace
                        {:changes [{:type :mod-obj :id (uuid/next) :operations []}]
                         :commit-id (uuid/next)
                         :revn revn}))
          finish     (fn []
                       (rx/dispose! sub)
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))]
      (->> (commit 3)
           (rx/mapcat (fn [ack]
                        (t/is (= {:revision "rev-local" :revn 3} ack)
                              "the rejection settles the save instead of failing it")
                        (t/is (= "rev-local" (:revision @@#'smallpen/workspace-state)))
                        (commit 4)))
           (rx/subs!
            (fn [ack]
              (t/is (= "rev-next" (:revision ack)))
              (t/is (= "rev-next" (:revision @@#'smallpen/workspace-state)))
              ;; The drop is emitted asynchronously.
              (js/setTimeout
               (fn []
                 (t/is (= 1 (count @dropped)) "the workspace drops the change once")
                 (finish))
               50))
            (fn [cause]
              (t/is false (str "a rejected change must not fail the save: " cause))
              (finish)))))))

;; Scenario: an image is pasted while an edit is still being saved. The
;; Media import moves the Package revision; were it written first, the
;; Background would refuse the edit as stale (409) and autosave would stop.
;; The import waits for the save, and the next edit builds on the import.
(t/deftest a-media-import-waits-for-the-save-in-flight
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          calls      (atom [])
          release    (atom nil)
          prev-fetch (http/install-fetch-mock!
                      (fn [url opts]
                        (cond
                          (str/includes? url "/v1/media/import")
                          (do (swap! calls conj [:import])
                              (js/Promise.resolve
                               (json-response 201 {:id (str (uuid/next))
                                                   :revision "rev-import"})))

                          (not (str/includes? url "/v1/penpot/commit"))
                          ;; A re-projection left by an earlier test.
                          (js/Promise. (fn [_ _]))

                          (empty? @calls)
                          (do (swap! calls conj [:commit (unchecked-get (js/JSON.parse (.-body opts)) "baseRevision")])
                              (js/Promise. (fn [resolve _] (reset! release resolve))))

                          :else
                          (do (swap! calls conj [:commit (unchecked-get (js/JSON.parse (.-body opts)) "baseRevision")])
                              (js/Promise.resolve (json-response 200 {:revision "rev-last"}))))))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))
          commit     (fn [revn]
                       (#'smallpen/commit-workspace
                        {:changes [{:type :mod-obj :id (uuid/next) :operations []}]
                         :commit-id (uuid/next)
                         :revn revn}))]
      (rx/subs! (fn [_]) (fn [_]) (commit 3))
      (->> (#'smallpen/upload-media
            {:content (js/Blob. #js ["x"] #js {:type "image/png"})
             :name "pasted"
             :is-local true})
           (rx/mapcat (fn [_] (commit 4)))
           (rx/subs!
            (fn [_]
              (t/is (= [[:commit "rev-local"] [:import] [:commit "rev-import"]]
                       @calls))
              (finish))
            (fn [cause]
              (t/is false (str cause))
              (finish))))
      (js/setTimeout
       (fn []
         (t/is (= [[:commit "rev-local"]] @calls)
               "the import is not sent while the save is in flight")
         (@release (json-response 200 {:revision "rev-saved"})))
       20))))

;; Scenario: an image is pasted, its upload succeeds, and the Background
;; refuses the change that places it (422). Penpot keeps such uploads out
;; of the library; a Package has library Media only, so the upload is
;; removed instead of staying behind as an unused library entry. Media that
;; a saved change already uses, or that was uploaded to the library, stays.
(t/deftest a-refused-paste-removes-its-uploaded-media
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          kept       (uuid/next)
          library    (uuid/next)
          orphan     (uuid/next)
          uploads    (atom [kept library orphan])
          bodies     (atom [])
          refuse?    (atom false)
          prev-fetch (http/install-fetch-mock!
                      (fn [url opts]
                        (cond
                          (str/includes? url "/v1/media/import")
                          (let [id (first @uploads)]
                            (swap! uploads rest)
                            (js/Promise.resolve
                             (json-response 201 {:id (str id)
                                                 :revision (str "rev-" id)})))

                          (str/includes? url "/v1/penpot/commit")
                          (let [body (js->clj (js/JSON.parse (.-body opts)) :keywordize-keys true)]
                            (swap! bodies conj body)
                            (js/Promise.resolve
                             (if (and @refuse? (not= "del-media" (-> body :changes first :type)))
                               (json-response 422 {:error {:code "unsupported_penpot_attribute"
                                                           :message "refused"}})
                               (json-response 200 {:revision (str "rev-" (count @bodies))}))))

                          ;; The roll-back re-projection; out of scope here.
                          :else
                          (js/Promise. (fn [_ _])))))
          upload     (fn [is-local]
                       (#'smallpen/upload-media
                        {:content (js/Blob. #js ["x"] #js {:type "image/png"})
                         :name "pasted"
                         :is-local is-local}))
          place      (fn [ids]
                       (#'smallpen/commit-workspace
                        {:changes (mapv (fn [id]
                                          {:type :add-obj
                                           :id (uuid/next)
                                           :obj {:type :rect
                                                 :fills [{:fill-image {:id id :width 1 :height 1}}]}})
                                        ids)
                         :commit-id (uuid/next)
                         :revn 1}))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))]
      (->> (upload true)
           (rx/mapcat (fn [_] (place [kept])))
           (rx/mapcat (fn [_] (upload false)))
           (rx/mapcat (fn [_] (upload true)))
           (rx/mapcat (fn [_]
                        (reset! bodies [])
                        (reset! refuse? true)
                        (place [kept library orphan])))
           (rx/subs!
            (fn [ack]
              (t/is (= 2 (count @bodies)))
              (t/is (= {:baseRevision (str "rev-" orphan)
                        :changes [{:type "del-media" :id (str orphan)}]}
                       (select-keys (second @bodies) [:baseRevision :changes]))
                    "only the refused paste's own upload is removed")
              (t/is (= "rev-2" (:revision ack)))
              (t/is (= #{} @@#'smallpen/local-media))
              (finish))
            (fn [cause]
              (t/is false (str "a refused paste must not fail the save: " cause))
              (finish)))))))

;; Scenario: two windows on one Package session. The Background announces
;; every write to both, this window's own included, and the announcement
;; can arrive before the write's own response. Only the other window's
;; writes are foreign, and those reconcile this window.
(t/deftest only-another-windows-write-is-foreign
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          release    (atom nil)
          revisions  (atom ["rev-own-1" "rev-own-2"])
          prev-fetch (http/install-fetch-mock!
                      (fn [url _opts]
                        (if-not (str/includes? url "/v1/penpot/commit")
                          ;; A re-projection left by an earlier test.
                          (js/Promise. (fn [_ _]))
                          (let [revision (first @revisions)]
                            (swap! revisions rest)
                            (if (= "rev-own-1" revision)
                              (js/Promise. (fn [resolve _]
                                             (reset! release #(resolve (json-response 200 {:revision revision})))))
                              (js/Promise.resolve (json-response 200 {:revision revision})))))))
          answers    (atom [])
          foreign?   @#'smallpen/foreign-write?
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))
          commit     (fn []
                       (#'smallpen/commit-workspace
                        {:changes [{:type :mod-obj :id (uuid/next) :operations []}]
                         :commit-id (uuid/next)
                         :revn 1}))]
      (rx/subs! (fn [_]) (fn [_]) (commit))
      (.then (foreign? "rev-own-1")
             #(swap! answers conj %))
      (js/setTimeout
       (fn []
         (t/is (empty? @answers) "the answer waits for the write in flight")
         (@release))
       20)
      (-> (foreign? "rev-own-1")
          (.then (fn [own]
                   (t/is (= [false] @answers)
                         "an announcement that beat its response is not foreign")
                   (t/is (false? own))
                   (js/Promise.
                    (fn [resolve reject]
                      (rx/subs! resolve reject (commit))))))
          (.then (fn [_]
                   (js/Promise.all
                    #js [(foreign? "rev-own-1")
                         (foreign? "rev-own-2")
                         (foreign? "rev-other")])))
          (.then (fn [result]
                   (t/is (= [false false true] (vec result))
                         "an earlier own write is still recognised")))
          (.catch (fn [cause] (t/is false (str cause))))
          (.finally finish)))))

(t/deftest only-a-refused-change-is-dropped
  (let [refusal (fn [status type]
                  (ex-info "x" {:type type :status status}))]
    (t/is (true? (#'smallpen/rejected-commit? (refusal 422 :smallpen-backend))))
    (t/is (false? (#'smallpen/rejected-commit? (refusal 409 :smallpen-backend)))
          "a stale revision keeps the reconciliation path")
    (t/is (false? (#'smallpen/rejected-commit? (refusal nil :network))))
    (t/is (false? (#'smallpen/rejected-commit? (js/Error. "boom"))))))

(defn- reload-events
  "Run the reconciliation flush against the given persistence state and
  resolve to the event types it emits."
  [persistence]
  (js/Promise.
   (fn [resolve reject]
     ;; The waiter reads the persistence status synchronously on subscribe.
     (with-redefs [refs/persistence (atom persistence)]
       (->> (ptk/watch (#'smallpen/persist-before-external-reload) nil nil)
            (rx/map #(if (keyword? %) % (ptk/type %)))
            (rx/reduce conj [])
            (rx/subs! resolve reject))))))

;; Scenario: the flush either saves (nothing conflicted: reload into the
;; external revision) or fails, for example with the 409 above (keep the
;; window and tell the user the local edits could not be merged).
(t/deftest external-reconciliation-reloads-only-after-a-clean-flush
  (t/async done
    (-> (reload-events {:status :saved :queue #queue []})
        (.then (fn [events]
                 (t/is (= [::dps/force-persist
                           :app.main.smallpen/finish-external-reconciliation]
                          events))
                 (reload-events {:status :error
                                 :queue #queue [(uuid/next)]
                                 :error {:code :save-failed}})))
        (.then (fn [events]
                 (t/is (= [::dps/force-persist
                           :app.main.smallpen/external-reconciliation-timeout]
                          events))))
        (.catch (fn [cause] (t/is false (str cause))))
        (.finally done))))

(t/deftest media-upload-name-is-sent-as-a-valid-header-value
  (let [blob    (js/Blob. #js ["x"] #js {:type "image/png"})
        headers (js/Headers. (#'smallpen/media-upload-headers blob "截图.png"))]
    (t/is (= "image/png" (.get headers "content-type")))
    (t/is (= "%E6%88%AA%E5%9B%BE.png" (.get headers "x-smallpen-media-name")))
    (t/is (= "截图.png"
             (js/decodeURIComponent (.get headers "x-smallpen-media-name")))))
  (t/is (= ""
           (unchecked-get (#'smallpen/media-upload-headers
                           (js/Blob. #js []) nil)
                          "x-smallpen-media-name"))))

(def ^:private imported-media
  {:file-id "1a2f3805-f825-5f0e-9c96-a5bc7bbfb532"
   :height 48
   :id "3cee8f31-6409-481c-acf7-18bfb40c0615"
   :is-local true
   :media-id "f4ad1c77-7324-5394-9979-ef8daa93a96e"
   :mtype "image/png"
   :name "截图"
   :revision "rev-next"
   :width 64})

;; Scenario: pasting, dropping or uploading an image. Penpot builds the image
;; shape from the uploaded media object; a string id fails the shape schema
;; and the image never lands on the canvas.
(t/deftest media-upload-answers-a-penpot-media-object
  (t/async done
    (let [restore    (enter-smallpen! {:file-id "file-1" :revision "rev-local"})
          prev-fetch (http/install-fetch-mock!
                      (fn [_url _opts]
                        (js/Promise.resolve (json-response 201 imported-media))))
          finish     (fn []
                       (http/restore-fetch! prev-fetch)
                       (restore)
                       (done))]
      (->> (rp/cmd! :upload-file-media-object
                    {:content (js/Blob. #js ["x"] #js {:type "image/png"})
                     :name "截图"})
           (rx/subs!
            (fn [media]
              (t/is (= (uuid/parse (:id imported-media)) (:id media)))
              (t/is (= (uuid/parse (:file-id imported-media)) (:file-id media)))
              (t/is (= (uuid/parse (:media-id imported-media)) (:media-id media)))
              (t/is (= {:width 64 :height 48 :mtype "image/png" :name "截图"}
                       (select-keys media [:width :height :mtype :name])))
              (t/is (not (contains? media :revision)))
              (t/is (= "rev-next" (:revision @@#'smallpen/workspace-state)))
              (finish))
            (fn [cause]
              (t/is false (str cause))
              (finish)))))))

(defn- cmd-result
  [id params]
  (let [result (atom nil)]
    (rx/subs! #(reset! result [:ok %])
              #(reset! result [:error (ex-data %)])
              (rp/cmd! id params))
    @result))

(t/deftest environment-data-disables-event-collection
  (let [restore (enter-smallpen! {})]
    (try
      (let [[outcome data] (cmd-result :get-environment-data {})]
        (t/is (= :ok outcome))
        (t/is (false? (ev/events-enabled? (:flags data)))
              "no telemetry or audit events are sent to the local host"))
      (finally
        (restore)))))

(t/deftest profile-props-fail-explicitly-unless-already-satisfied
  (let [restore (enter-smallpen! {})]
    (try
      (t/is (= [:ok nil]
               (cmd-result :update-profile-props
                           {:props {:workspace-visited true
                                    :v2-info-shown true
                                    :onboarding-viewed true
                                    :release-notes-viewed "2.0"}})))
      (let [[outcome data] (cmd-result :update-profile-props
                                       {:props {:nudge {:big 20}
                                                :workspace-visited true}})]
        (t/is (= :error outcome))
        (t/is (= :smallpen-unsupported-profile-props (:code data)))
        (t/is (= [:nudge] (:props data))))
      (finally
        (restore)))))

(t/deftest reprojection-results-apply-only-to-the-current-revision
  (let [restore (enter-smallpen! {:file-id (str fixture/file-id)
                                  :revision "rev-2"})]
    (try
      (t/is (true? (#'smallpen/current-projection? fixture/file-id
                                                   {:revision "rev-2"})))
      (t/is (false? (#'smallpen/current-projection? fixture/file-id
                                                    {:revision "rev-1"})))
      (t/is (false? (#'smallpen/current-projection? (uuid/next)
                                                    {:revision "rev-2"})))
      (t/is (false? (#'smallpen/current-projection? fixture/file-id {})))
      (finally
        (restore)))))

(defn- undo-entry
  [label]
  {:undo-changes [{:type :mod-page :id uuid/zero :name label}]
   :redo-changes [{:type :mod-page :id uuid/zero :name label}]
   :undo-group uuid/zero
   :tags #{}})

(t/deftest undo-stack-restore-protects-only-a-truncated-redo-tail
  (let [a        (undo-entry "a")
        b        (undo-entry "b")
        c        (undo-entry "c")
        ride     (undo-entry "measure")
        ;; The user undid c and b; the redo tail is [b c].
        captured {:items [a b c] :index 0}]
    (t/testing "a ride-along commit truncated the redo tail: restore it"
      (t/is (= captured
               (#'smallpen/settled-undo-stack captured
                                              {:items [a ride] :index 1}))))
    (t/testing "nothing happened: keep the current stack"
      (t/is (= captured
               (#'smallpen/settled-undo-stack captured captured))))
    (t/testing "the user redid: keep the redo pointer"
      (let [current {:items [a b c] :index 2}]
        (t/is (= current (#'smallpen/settled-undo-stack captured current)))))
    (t/testing "the user undid into the newer entries: keep them"
      (let [current {:items [a ride] :index 0}]
        (t/is (= current (#'smallpen/settled-undo-stack captured current)))))
    (t/testing "an entry below the captured index changed: keep current"
      (let [current {:items [ride] :index 0}]
        (t/is (= current (#'smallpen/settled-undo-stack captured current)))))
    (t/testing "no redo tail was captured: keep current"
      (let [top     {:items [a] :index 0}
            current {:items [a ride] :index 1}]
        (t/is (= current (#'smallpen/settled-undo-stack top current)))))))

(defn- commit-event
  [& {:as options}]
  (dch/commit (merge {:redo-changes [{:type :mod-page :id uuid/zero :name "after"}]
                      :undo-changes [{:type :mod-page :id uuid/zero :name "before"}]
                      :origin (ptk/reify ::edit)
                      :save-undo? true
                      :stack-undo? false}
                     options)))

(defn- restore-events
  "Drive `restore-undo-stack` with controlled time: `steps` runs against the
  swap, commit stream and settle timer subjects. Returns the emitted events."
  [steps]
  (let [file-id (uuid/next)
        swapped (rx/subject)
        stream  (rx/subject)
        timer   (rx/subject)
        events  (atom [])]
    (with-redefs [rx/timer (constantly timer)]
      (rx/subs! #(swap! events conj %)
                (#'smallpen/restore-undo-stack file-id {:items [] :index -1}
                                               swapped stream))
      (steps {:swapped swapped :stream stream :timer timer}))
    @events))

(defn- settle!
  [subject]
  (rx/push! subject 0)
  (rx/end! subject))

;; Scenario: the user undoes on a generated page, the page re-projects and
;; the renderer's follow-up commits land; then, inside the settle window,
;; the user makes a real edit. That edit truncates the redo tail on purpose
;; and must stay in history, so the captured stack is not restored.
(t/deftest undo-restore-tells-follow-up-commits-from-user-edits
  (t/testing "renderer follow-ups alone: the captured stack comes back"
    (t/is (= [:app.main.smallpen/restore-undo-stack!]
             (map ptk/type
                  (restore-events
                   (fn [{:keys [swapped stream timer]}]
                     (rx/push! swapped :replaced)
                     (rx/push! stream (commit-event :save-undo? false))
                     (rx/push! stream (commit-event :stack-undo? true))
                     (settle! timer)))))))
  (t/testing "a user edit inside the window cancels the restore"
    (t/is (empty? (restore-events
                   (fn [{:keys [swapped stream timer]}]
                     (rx/push! swapped :replaced)
                     (rx/push! stream (commit-event))
                     (settle! timer))))))
  (t/testing "a user edit before the swap lands cancels it too"
    (t/is (empty? (restore-events
                   (fn [{:keys [swapped stream timer]}]
                     (rx/push! stream (commit-event))
                     (rx/push! swapped :replaced)
                     (settle! timer))))))
  (t/testing "remote commits are not user edits"
    (t/is (= 1 (count (restore-events
                       (fn [{:keys [swapped stream timer]}]
                         (rx/push! swapped :replaced)
                         (rx/push! stream (commit-event :source :remote))
                         (settle! timer))))))))

(t/deftest token-import-applies-against-the-reviewed-revision
  (t/is (= "rev-server" (#'token-import/review-revision {:revision "rev-server"} "rev-local")))
  (t/is (= "rev-local" (#'token-import/review-revision {} "rev-local")))
  (t/is (= (tr "smallpen.tokens.import.stale-review")
           (#'token-import/apply-error-message
            (ex-info "stale" {:type :smallpen-backend :code :stale_revision :status 409}))))
  (t/is (= "Bad document"
           (#'token-import/apply-error-message
            (ex-info "Bad document" {:type :smallpen-backend :status 422})))))

(defn- fake-session-storage
  []
  (let [items (atom {})]
    #js {:getItem (fn [key] (get @items key))
         :setItem (fn [key value] (swap! items assoc key (str value)))
         :removeItem (fn [key] (swap! items dissoc key))}))

;; Scenario: the Background answers an external revision with
;; historyCleared, because every local Undo/Redo entry targets content that
;; no longer exists. Penpot's own stack is cleared at once, and a notice is
;; staged for the reconciliation reload of that Package session only.
(t/deftest external-revision-that-cleared-history-clears-penpot-undo
  (let [restore  (enter-smallpen! {:file-id "file-1"
                                   :package-session-id "session-1"
                                   :revision "rev-local"})
        previous (unchecked-get js/globalThis "sessionStorage")]
    (unchecked-set js/globalThis "sessionStorage" (fake-session-storage))
    ;; A reconciliation is already running, so the event only adds the
    ;; history handling under test.
    (reset! @#'smallpen/external-reconciliation? true)
    (try
      (swap! st/state assoc :workspace-undo {:items [{:undo-changes []}] :index 0})
      (#'smallpen/handle-event! #js {:type "external-revision"
                                     :sessionId "session-2"
                                     :historyCleared true})
      (t/is (= 0 (get-in @st/state [:workspace-undo :index]))
            "another Package session's event is ignored")
      (#'smallpen/handle-event! #js {:type "external-revision"
                                     :sessionId "session-1"
                                     :historyCleared false})
      (t/is (= 0 (get-in @st/state [:workspace-undo :index])))
      (t/is (not (#'smallpen/take-history-cleared-notice! "session-1")))
      (#'smallpen/handle-event! #js {:type "external-revision"
                                     :sessionId "session-1"
                                     :historyCleared true})
      (t/is (= {} (:workspace-undo @st/state)))
      (t/is (not (#'smallpen/take-history-cleared-notice! "session-2")))
      (t/is (true? (#'smallpen/take-history-cleared-notice! "session-1")))
      (t/is (not (#'smallpen/take-history-cleared-notice! "session-1"))
            "the notice shows once")
      ;; The Background history can come from another window: with nothing
      ;; to undo here, there is nothing to tell the user.
      (#'smallpen/handle-event! #js {:type "external-revision"
                                     :sessionId "session-1"
                                     :historyCleared true})
      (t/is (not (#'smallpen/take-history-cleared-notice! "session-1")))
      (finally
        (swap! st/state dissoc :workspace-undo)
        (unchecked-set js/globalThis "sessionStorage" previous)
        (restore)))))

;; Scenario: a path edit on the Design System board. Penpot reports the
;; copy's page-absolute geometry, so the commit carries the layout offset
;; its tree is drawn with; other edits are sent unchanged.
(t/deftest generated-page-edits-carry-their-layout-offset
  (let [file-id  (uuid/next)
        page-id  (uuid/next)
        copy-id  (uuid/next)
        plain-id (uuid/next)
        state    {:current-file-id file-id
                  :files {file-id
                          {:data
                           {:pages-index
                            {page-id
                             {:plugin-data {:smallpen {"design-system-page" true}}
                              :objects
                              {copy-id {:id copy-id
                                        :plugin-data {:smallpen {"layout-offset" "500 -12.5"}}}
                               plain-id {:id plain-id
                                         :plugin-data {:smallpen {"node-id" "node_plain"}}}}}}}}}}
        changes  [{:type :mod-obj :id copy-id :page-id page-id :operations []}
                  {:type :mod-obj :id plain-id :page-id page-id :operations []}
                  {:type :add-obj :id copy-id :page-id page-id :obj {}}]
        result   (smallpen/with-layout-offsets state changes)]
    (t/is (= {:x 500 :y -12.5} (:smallpen-layout-offset (first result))))
    (t/is (= (rest changes) (rest result)))
    (t/is (= {"x" 500 "y" -12.5}
             (get (#'smallpen/json-value (first result)) "smallpen-layout-offset")))))

;; Scenario: a layer added inside a variant main on the Components page. It
;; has no offset of its own yet; it is drawn with its main's tree, so its
;; add-obj carries that offset, and the main's current geometry (mains move
;; freely there without saving their place).
(t/deftest components-page-additions-carry-their-tree-offset
  (let [file-id  (uuid/next)
        page-id  (uuid/next)
        main-id  (uuid/next)
        layer-id (uuid/next)
        state    {:current-file-id file-id
                  :files {file-id
                          {:data
                           {:pages-index
                            {page-id
                             {:plugin-data {:smallpen {"components-page" true}}
                              :objects
                              {main-id {:id main-id
                                        :parent-id uuid/zero
                                        :x 40 :y 376 :width 96 :height 32
                                        :plugin-data {:smallpen {"layout-offset" "30 366"}}}
                               layer-id {:id layer-id :parent-id main-id}}}}}}}}
        result   (smallpen/with-layout-offsets
                   state
                   [{:type :add-obj :id layer-id :page-id page-id
                     :parent-id main-id :obj {}}])]
    (t/is (= {:x 30 :y 366} (:smallpen-layout-offset (first result))))
    (t/is (= {:id main-id
              :geometry {:x 40 :y 376 :width 96 :height 32}
              :child {}}
             (:smallpen-parent (first result))))))

;; Scenario: a variant edit the Package cannot hold is refused; the toast
;; explains it in the user's language, other refusals keep their message.
(t/deftest variant-refusals-get-a-translated-reason
  (let [refusal (fn [code message]
                  (#'smallpen/rejection-reason
                   (ex-info message {:type :smallpen-backend :status 422 :code code})))]
    (t/is (= (tr "smallpen.variants.duplicate-selection")
             (refusal :variant_duplicate_selection "Two variants of Button ...")))
    (t/is (= (tr "smallpen.variants.in-use")
             (refusal :variant_in_use "Chip is still used by ...")))
    (t/is (= "Penpot runtime page is not mapped"
             (refusal :unknown_runtime_page "Penpot runtime page is not mapped")))))

;; Scenario: a copy dropped on a screen inherited its main's layout offset.
;; Outside a generated page the offset means nothing; sending it shifted the
;; dropped instance by the main's position on the Components page.
(t/deftest layout-offsets-apply-only-on-generated-pages
  (let [file-id (uuid/next)
        page-id (uuid/next)
        copy-id (uuid/next)
        state   {:current-file-id file-id
                 :files {file-id
                         {:data
                          {:pages-index
                           {page-id
                            {:objects
                             {copy-id {:id copy-id
                                       :plugin-data {:smallpen {"layout-offset" "472 0"}}}}}}}}}}
        changes [{:type :mod-obj :id copy-id :page-id page-id :operations []}]]
    (t/is (= changes (smallpen/with-layout-offsets state changes)))))
