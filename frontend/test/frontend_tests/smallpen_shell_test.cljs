;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen-shell-test
  "SmallPen hooks in the app shell: routing adapter, routes and the DS page
  commit gate."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.workspace.shapes :as-alias dwsh]
   [app.main.router :as rt]
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.edit-policy :as policy]
   [app.main.smallpen.routing :as sprt]
   [app.main.ui.routes :as routes]
   [app.rasterizer :as rasterizer]
   [app.util.globals :as globals]
   [cljs.test :as t :include-macros true]
   [potok.v2.core :as ptk]))

(def ^:private test-routes
  #{:workspace :viewer :smallpen-home :smallpen-design-system})

(def ^:private local-location
  #js {:search "?screen=workspace&file-id=old&smallpen-backend=http%3A%2F%2F127.0.0.1%3A43130&smallpen-package=session-2"})

;; --- Routing

(t/deftest route-params-keep-the-package-connection
  (with-redefs [globals/location local-location]
    (let [params (sprt/route-params :workspace {:file-id "new" :team-id "t"})]
      (t/is (= "new" (:file-id params)))
      (t/is (= "session-2" (:smallpen-package params)))
      (t/is (= "http://127.0.0.1:43130" (:smallpen-backend params)))
      (t/is (not (contains? params :team-id))
            "workspace URLs omit the synthetic local team id"))
    (t/is (= "t" (:team-id (sprt/route-params :viewer {:team-id "t"}))))))

(t/deftest router-applies-the-installed-params-adapter
  (with-redefs [globals/location local-location]
    (t/is (= "?screen=workspace&file-id=new"
             (rt/resolve test-routes :workspace {:file-id "new"}))
          "no adapter keeps upstream resolution")
    (try
      (rt/set-params-adapter! sprt/route-params)
      (let [token  (rt/resolve test-routes :workspace {:file-id "new" :team-id "t"})
            params (get-in (rt/match test-routes token) [:params :query])]
        (t/is (= "new" (:file-id params)))
        (t/is (= "session-2" (:smallpen-package params)))
        (t/is (nil? (:team-id params))))
      (finally
        (rt/set-params-adapter! nil)))))

(t/deftest install-is-a-no-op-outside-smallpen
  (with-redefs [globals/location local-location]
    (sprt/install!)
    (t/is (= "?screen=workspace&file-id=new"
             (rt/resolve test-routes :workspace {:file-id "new"})))))

(t/deftest smallpen-screens-use-the-query-route-contract
  (let [router (rt/create routes/routes)]
    (t/is (= :smallpen-home
             (get-in (rt/match router "?screen=smallpen-home") [:data :name])))
    (t/is (= "f1"
             (get-in (rt/match router "?screen=smallpen-design-system&file-id=f1")
                     [:params :query :file-id])))))

(t/deftest redirect-rules
  (let [match (fn [screen] {:data {:name screen}})]
    (t/testing "outside SmallPen"
      (t/is (nil? (sprt/redirect (match :dashboard-recent) {:screen "dashboard-recent"})))
      (t/is (nil? (sprt/redirect nil {})))
      (t/is (= ::rt/assign-exception
               (ptk/type (sprt/redirect (match :smallpen-home) {:screen "smallpen-home"})))))
    (t/testing "inside SmallPen"
      (with-redefs [smallpen/enabled? (constantly true)]
        (t/is (= ::rt/navigate
                 (ptk/type (sprt/redirect nil {}))))
        (t/is (= :smallpen-home
                 (:id @(sprt/redirect (match :dashboard-recent) {:screen "dashboard-recent"}))))
        (t/is (nil? (sprt/redirect (match :workspace) {:screen "workspace"})))
        (t/is (nil? (sprt/redirect (match :smallpen-home) {:screen "smallpen-home"})))))))

;; --- Rasterizer

(t/deftest rasterizer-keeps-width-only-sizing-without-height
  (let [options (#'rasterizer/bitmap-resize-options 1024 nil "medium")]
    (t/is (= 1024 (unchecked-get options "resizeWidth")))
    (t/is (undefined? (unchecked-get options "resizeHeight"))))
  (let [options (#'rasterizer/bitmap-resize-options 1024 768 "medium")]
    (t/is (= 768 (unchecked-get options "resizeHeight")))))

;; --- DS page commit gate

(def ^:private page-id   #uuid "5e110000-0000-4000-8000-000000000001")
(def ^:private source-id #uuid "5e110000-0000-4000-8000-000000000002")
(def ^:private deco-id   #uuid "5e110000-0000-4000-8000-000000000003")

(defn- ds-file
  [& {:keys [smallpen?] :or {smallpen? true}}]
  {:data
   (cond-> {:pages [page-id]
            :pages-index
            {page-id
             {:id page-id
              :plugin-data {:smallpen {"design-system-page" true}}
              :objects
              {uuid/zero {:id uuid/zero :type :frame :shapes [deco-id]}
               deco-id   {:id deco-id :type :frame :shapes [source-id]}
               source-id {:id source-id :type :rect
                          :plugin-data {:smallpen {"design-system" "source"}}}}}}}
     smallpen? (assoc :plugin-data {:smallpen {"package-id" "p"}}))})

(defn- modify
  [id & attrs]
  {:type :mod-obj :page-id page-id :id id
   :operations (mapv (fn [attr] {:type :set :attr attr :val 1}) attrs)})

(def ^:private propagation ::dwsh/update-shapes-buffer)

(t/deftest gate-skips-files-that-are-not-smallpen-projections
  (t/is (nil? (policy/commit-block-reason (ds-file :smallpen? false)
                                          [{:type :del-obj :page-id page-id :id source-id}]))))

(t/deftest gate-treats-propagation-reflow-as-bookkeeping
  (let [file (ds-file)]
    (t/is (= :position (policy/commit-block-reason file [(modify source-id :x :y)])))
    (t/is (nil? (policy/commit-block-reason file [(modify source-id :x :y)] propagation))
          "layout reflow moves children while tokens propagate")
    (t/is (= :decoration (policy/commit-block-reason file [(modify deco-id :width :height)])))
    (t/is (nil? (policy/commit-block-reason file [(modify deco-id :width :height :selrect)]
                                            propagation))
          "hugging containers resize while tokens propagate")
    (t/is (= :structure (policy/commit-block-reason file [(modify source-id :layout-gap)])))
    (t/is (nil? (policy/commit-block-reason file [(modify source-id :layout-gap)] propagation))
          "spacing tokens write layout values")))

(t/deftest gate-still-rejects-real-edits-during-propagation
  (let [file (ds-file)]
    (t/is (= :decoration (policy/commit-block-reason file [(modify deco-id :fills)] propagation)))
    (t/is (= :structure (policy/commit-block-reason file [(modify source-id :layout)] propagation)))
    (t/is (= :structure (policy/commit-block-reason
                         file [{:type :del-obj :page-id page-id :id source-id}] propagation)))))

(t/deftest gate-refuses-page-changes-on-generated-pages
  (let [components-id #uuid "5e110000-0000-4000-8000-000000000004"
        normal-id     #uuid "5e110000-0000-4000-8000-000000000005"
        file          (-> (ds-file)
                          (assoc-in [:data :pages-index components-id]
                                    {:id components-id
                                     :plugin-data {:smallpen {"components-page" true}}
                                     :objects {}})
                          (assoc-in [:data :pages-index normal-id]
                                    {:id normal-id :objects {}}))
        rename        (fn [id] {:type :mod-page :id id :name "Renamed"})]
    (t/is (= :generated-page (policy/commit-block-reason file [(rename components-id)])))
    (t/is (= :generated-page (policy/commit-block-reason file [(rename page-id)])))
    (t/is (= :generated-page (policy/commit-block-reason
                              file [{:type :del-page :id components-id}])))
    (t/is (= :generated-page (policy/commit-block-reason
                              file [{:type :mov-page :id components-id :index 0}])))
    (t/is (nil? (policy/commit-block-reason file [(rename normal-id)])))))

(t/deftest drawing-is-blocked-only-on-ds-pages
  (let [file-id (uuid/next)
        state   {:current-file-id file-id
                 :current-page-id page-id
                 :files {file-id (ds-file)}}]
    (t/is (policy/drawing-blocked? state :rect))
    (t/is (not (policy/drawing-blocked? state :comments)))
    (t/is (not (policy/drawing-blocked? (assoc state :current-page-id (uuid/next)) :rect)))))

;; Scenario: a component dropped from Assets is instantiated from its main,
;; plugin-data included. The copy must not keep the main's SmallPen
;; identity: its layout offset moved the dropped instance on save. A main
;; and an undo that restores a projected instance keep theirs.
(t/deftest instantiated-copies-drop-the-main-identity
  (let [main-data {:smallpen {"component-id" "cmp_card_set"
                              "node-id" "node_card_root"
                              "variant-id" "var_card_idle"
                              "layout-offset" "472 0"}}
        copy      {:type :add-obj :id (uuid/next) :page-id page-id
                   :obj {:component-id (uuid/next) :component-root true
                         :shape-ref (uuid/next) :plugin-data main-data}}
        child     {:type :add-obj :id (uuid/next) :page-id page-id
                   :obj {:shape-ref (uuid/next) :plugin-data main-data}}
        main      {:type :add-obj :id (uuid/next) :page-id page-id
                   :obj {:component-id (uuid/next) :main-instance true
                         :plugin-data main-data}}
        restored  {:type :add-obj :id (uuid/next) :page-id page-id
                   :obj {:component-id (uuid/next) :component-root true
                         :shape-ref (uuid/next)
                         :plugin-data {:smallpen {"node-id" "node_card_instance"
                                                  "screen-id" "scr_a"
                                                  "presentation-id" "pres_a"}}}}
        result    (policy/without-copied-identity (ds-file) [copy child main restored])]
    (t/is (= [{} {} main-data (:plugin-data (:obj restored))]
             (mapv #(get-in % [:obj :plugin-data]) result)))
    (t/is (= [copy child]
             (policy/without-copied-identity (ds-file :smallpen? false) [copy child]))
          "plain Penpot files are untouched")))
