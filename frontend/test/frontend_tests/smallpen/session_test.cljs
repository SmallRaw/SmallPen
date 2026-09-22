;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.session-test
  (:require
   [app.main.data.persistence :as dps]
   [app.main.data.workspace.common :as dwc]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as session]
   [cljs.test :as t]
   [frontend-tests.smallpen.projection-test :as fixture]
   [potok.v2.core :as ptk]))

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
            "http://127.0.0.1:43128/?smallpen-backend=http%3A%2F%2F127.0.0.1%3A43127%2Fsession%2F&smallpen-package=package-2#/workspace"))))

(t/deftest smallpen-runtime-options-read-the-query-route
  (t/is (= {:backend-url "http://127.0.0.1:43130"
            :file-id "file-query"}
           (smallpen/runtime-options
            "http://localhost/?screen=workspace&file-id=file-query&smallpen-backend=http%3A%2F%2F127.0.0.1%3A43130"
            nil))))

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
