;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.upstream-inert-test
  "Upstream Penpot code paths that carry SmallPen hooks behave exactly as
  upstream when the SmallPen profile is off (the default in these tests)."
  (:require
   [app.main.data.common :as dcm]
   [app.main.data.viewer :as dv]
   [app.main.router :as rt]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.edit-policy :as dsep]
   [app.main.smallpen.routing :as sprt]
   [app.main.smallpen.ui.history :as sp-history]
   [app.main.smallpen.ui.layers :as sp-layers]
   [app.main.smallpen.ui.token-modal :as sp-token-modal]
   [app.main.ui.workspace.sidebar.assets.media :as wsam]
   [app.main.ui.workspace.sidebar.history :as history]
   [app.main.ui.workspace.tokens.management.forms.controls.utils :as controls-utils]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [potok.v2.core :as ptk]))

(defn- watch-events
  "Synchronously collect the events emitted by `event`'s watch."
  [event state]
  (let [out (atom [])]
    (some->> (ptk/watch event state nil)
             (rx/subs! #(swap! out conj %)))
    @out))

(t/deftest smallpen-is-off-by-default
  (t/is (false? (smallpen/enabled?)))
  (t/is (every? smallpen/capability-enabled?
                [:comments :presence :plugins :mcp :remote-history])))

;; --- Workspace history ----------------------------------------------------

(defn- token-change
  [attrs]
  {:type :set-token :set-id (random-uuid) :token-id (random-uuid) :attrs attrs})

(t/deftest history-ignores-token-changes-like-upstream
  (t/is (nil? (history/parse-change (token-change {:name "a"}) (token-change nil))))
  (t/is (= [nil] (history/parse-entry {:redo-changes [(token-change {:name "a"})]
                                       :undo-changes [(token-change nil)]})))
  (let [shape-id (random-uuid)
        entry    (history/select-entry
                  (history/parse-entry
                   {:redo-changes [{:type :mod-obj :id shape-id :operations []}
                                   (token-change {:name "a"})]
                    :undo-changes []}))]
    (t/is (= {:type :shape :operation :modify :id shape-id}
             (select-keys entry [:type :operation :id])))))

(t/deftest history-keeps-one-row-per-undo-entry
  (let [group (random-uuid)
        rows  (sp-history/undo-rows [{:undo-group group :redo-changes [] :undo-changes []}
                                     {:undo-group group :redo-changes [] :undo-changes []}
                                     {:undo-group nil :redo-changes [] :undo-changes []}])]
    (t/is (= [0 1 2] (mapv ::sp-history/start-index rows)))
    (t/is (= [0 1 2] (mapv ::sp-history/end-index rows)))))

;; --- Viewer navigation ------------------------------------------------------

(def ^:private page-a (random-uuid))
(def ^:private page-b (random-uuid))
(def ^:private frame-a (random-uuid))
(def ^:private frame-b (random-uuid))

(def ^:private viewer-state
  {:route  {:query-params {:page-id (str page-a) :index "0"}
            :params {:query {:page-id (str page-a) :index "0"}}}
   :viewer {:pages {page-a {:frames [{:id frame-a}]}
                    page-b {:frames [{:id (random-uuid)} {:id frame-b}]}}}})

(t/deftest viewer-go-to-frame-stays-in-the-page-outside-smallpen
  (t/testing "a frame of the current page"
    (let [[event] (watch-events (dv/go-to-frame frame-a) viewer-state)]
      (t/is (= ::dv/go-to-frame-by-index (ptk/type event)))))

  (t/testing "a frame of another page falls back to the first frame"
    (let [[event] (watch-events (dv/go-to-frame frame-b) viewer-state)
          [nav]   (watch-events event viewer-state)]
      (t/is (= ::dv/go-to-frame-by-index (ptk/type event)))
      (t/is (= "0" (str (get-in @nav [:params :index])))))))

(t/deftest viewer-go-to-frame-crosses-pages-in-smallpen
  (with-redefs [smallpen/enabled? (constantly true)]
    (let [[event] (watch-events (dv/go-to-frame frame-b) viewer-state)]
      (t/is (= ::rt/navigate (ptk/type event)))
      (t/is (= {:page-id page-b :index 1}
               (select-keys (:params @event) [:page-id :index]))))))

;; --- Workspace navigation ---------------------------------------------------

(t/deftest go-to-workspace-keeps-the-route-board-id
  (let [board-id (str (random-uuid))
        page-id  (random-uuid)
        state    {:current-team-id (random-uuid)
                  :route {:params {:query {:board-id board-id}}}}
        [nav]    (watch-events (dcm/go-to-workspace :file-id (random-uuid)
                                                    :page-id page-id)
                               state)]
    (t/is (= board-id (get-in @nav [:params :board-id])))
    (t/is (= page-id (get-in @nav [:params :page-id])))))

;; --- Edit policy --------------------------------------------------------

(t/deftest commit-gate-skips-files-without-smallpen-data
  (let [page-id (random-uuid)
        file    {:data {:pages-index
                        {page-id {:plugin-data {:smallpen {"design-system-page" true}}}}}}
        ;; Realizing a change would throw: the gate must not scan them.
        changes (map (fn [_] (throw (js/Error. "scanned"))) [1])]
    (t/is (nil? (dsep/commit-block-reason file changes)))))

(t/deftest plugin-strings-do-not-lock-a-page
  ;; Plugins store strings; only the SmallPen projection writes `true`.
  (let [page-id (random-uuid)
        state   {:current-file-id :file
                 :current-page-id page-id
                 :files {:file {:data {:pages-index
                                       {page-id {:plugin-data {:smallpen {"design-system-page" "true"}}}}}}}}]
    (t/is (false? (dsep/current-page-locked? state)))))

;; --- Routing and UI helpers -----------------------------------------------

(t/deftest routing-hooks-are-inert
  (t/is (nil? (sprt/redirect {:data {:name :dashboard-recent}} {})))
  (t/is (nil? (sprt/redirect {:data {:name :workspace}} {:screen "workspace"})))
  (t/is (= ::rt/assign-exception
           (ptk/type (sprt/redirect {:data {:name :smallpen-home}}
                                    {:screen "smallpen-home"}))))
  (t/is (nil? (sprt/viewer-frame-nav viewer-state frame-b))))

(t/deftest ui-hooks-are-inert
  (t/is (nil? (sp-token-modal/undo-group)))
  (let [set-id (random-uuid)]
    (t/is (= [set-id {:a 1}] (sp-token-modal/target-set nil set-id {:a 1} nil)))
    (t/is (= [set-id {:a 1}] (sp-token-modal/target-set set-id set-id {:a 1} nil))))
  (t/is (false? (sp-layers/skip-page-rename? "Page 1" "Page 1")))
  (t/is (false? (wsam/media-drop? nil))))

(t/deftest sitemap-skips-unedited-renames-in-smallpen
  (with-redefs [smallpen/enabled? (constantly true)]
    (t/is (true? (sp-layers/skip-page-rename? "Page 1" "Page 1")))
    (t/is (false? (sp-layers/skip-page-rename? "Page 1" "Page 2")))))

(t/deftest token-dropdown-keeps-plain-resolved-values
  (let [options @(controls-utils/get-token-dropdown-options
                  {:spacing [{:id "s" :name "spacing.md" :value "16" :resolved-value 16}]}
                  "")
        option  (some #(when (= :token (:type %)) %) options)]
    (t/is (= {:id "s" :type :token :value "16" :resolved-value 16 :name "spacing.md"}
             option))))
