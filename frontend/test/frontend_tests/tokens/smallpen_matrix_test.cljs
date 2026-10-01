;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.tokens.smallpen-matrix-test
  (:require
   [app.common.files.tokens :as cfo]
   [app.common.test-helpers.compositions :as ctho]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.main.data.changes :as dch]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.undo :as dwu]
   [app.main.smallpen.token-matrix :as sptm]
   [app.main.smallpen.token-state :as spts]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.pages :as thp]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.helpers.wasm :as thw]
   [frontend-tests.tokens.helpers.state :as tohs]
   [potok.v2.core :as ptk]))

(t/use-fixtures :each
  {:before (fn []
             (thp/reset-idmap!)
             (thw/setup-wasm-mocks!))
   :after  thw/teardown-wasm-mocks!})

(defn- setup-file []
  (cthf/sample-file :file-1 :page-label :page-1))

(defn- current-tokens-library [file]
  (spts/file-library (:data file)))

(defn- activate-file-theme [file id]
  (update file :data
          (fn [data]
            (assoc data :tokens-status
                   (cfo/activate-theme (:tokens-status data) (:tokens-lib data) id)))))

(defn- setup-file-with-matrix-token-lib-legacy
  []
  (-> (setup-file)
      (assoc-in [:data :tokens-lib]
                (-> (ctob/make-tokens-lib)
                    (ctob/add-set
                     (ctob/make-token-set
                      :id (cthi/new-id! :mobile-set)
                      :name "Device/Mobile"
                      :tokens [["space.page"
                                (ctob/make-token
                                 :id (cthi/new-id! :mobile-space)
                                 :name "space.page"
                                 :type :spacing
                                 :value 16)]]))
                    (ctob/add-set
                     (ctob/make-token-set
                      :id (cthi/new-id! :desktop-set)
                      :name "Device/Desktop"
                      :tokens [["space.page"
                                (ctob/make-token
                                 :id (cthi/new-id! :desktop-space)
                                 :name "space.page"
                                 :type :spacing
                                 :value 24)]]))
                    (ctob/add-theme
                     (ctob/make-token-theme
                      :id (cthi/new-id! :mobile-theme)
                      :group "Device"
                      :name "Mobile"
                      :sets #{"Device/Mobile"}))
                    (ctob/add-theme
                     (ctob/make-token-theme
                      :id (cthi/new-id! :desktop-theme)
                      :group "Device"
                      :name "Desktop"
                      :sets #{"Device/Desktop"}))))))

(defn- setup-file-with-matrix-token-lib
  []
  (let [file (setup-file-with-matrix-token-lib-legacy)]
    (assoc-in file [:data :tokens-status]
              (cfo/make-tokens-status-from-lib (get-in file [:data :tokens-lib])))))

(t/deftest create-token-in-sets-copies-the-initial-value-once
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          token (ctob/make-token :name "radius.card"
                                 :type :border-radius
                                 :value 12)
          events [(sptm/create-token-in-sets
                   [(cthi/id :mobile-set) (cthi/id :desktop-set)]
                   token)]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               mobile-token (get (ctob/get-tokens lib (cthi/id :mobile-set))
                                 "radius.card")
               desktop-token (get (ctob/get-tokens lib (cthi/id :desktop-set))
                                  "radius.card")]
           (t/is (= [12 12] (mapv :value [mobile-token desktop-token])))
           (t/is (not= (:id mobile-token) (:id desktop-token)))))))))

(t/deftest duplicate-matrix-variant-copies-the-first-column-independently
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          events [(sptm/duplicate-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set))
                  (dwtl/update-token
                   (cthi/id :mobile-set)
                   (cthi/id :mobile-space)
                   {:value 20})]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               themes (remove ctob/hidden-theme? (ctob/get-themes lib))
               copied-theme (first (remove #(contains? #{"Mobile" "Desktop"}
                                                       (:name %))
                                           themes))
               copied-set-name (first (:sets copied-theme))
               copied-set (ctob/get-set-by-name lib copied-set-name)
               source-token (get (ctob/get-tokens lib (cthi/id :mobile-set))
                                 "space.page")
               copied-token (get (ctob/get-tokens lib (ctob/get-id copied-set))
                                 "space.page")]
           (t/is (= 3 (count themes)))
           (t/is (= "Device" (:group copied-theme)))
           (t/is (spts/theme-active? lib (ctob/get-id copied-theme)))
           (t/is (= 20 (:value source-token)))
           (t/is (= 16 (:value copied-token)))
           (t/is (not= (ctob/get-id copied-set) (cthi/id :mobile-set)))
           (t/is (not= (:id copied-token) (:id source-token)))))))))

(t/deftest create-matrix-domain-adds-and-activates-a-real-default-pair
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          store (ths/setup-store file)
          events [(sptm/create-token-matrix-domain "Mode")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               token-set (ctob/get-set-by-name lib "Mode/Default")
               token-theme (ctob/get-theme-by-name lib "Mode" "Default")]
           (t/is (some? token-set))
           (t/is (empty? (ctob/get-tokens lib (ctob/get-id token-set))))
           (t/is (= #{"Mode/Default"} (:sets token-theme)))
           (t/is (spts/theme-active? lib (ctob/get-id token-theme)))))))))

(t/deftest create-first-theme-from-a-file-without-a-token-library
  (t/async
    done
    (let [store (ths/setup-store (setup-file))
          events [(sptm/create-token-matrix-domain "Theme")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)
               token-set (ctob/get-set-by-name lib "Theme/Default")
               token-theme (ctob/get-theme-by-name lib "Theme" "Default")]
           (t/is (some? token-set))
           (t/is (some? token-theme))
           (t/is (spts/theme-active? lib (ctob/get-id token-theme)))))))))

(t/deftest activate-matrix-variant-preserves-other-domain-selections
  (t/async
    done
    (let [file (setup-file-with-matrix-token-lib)
          mode-theme (ctob/make-token-theme
                      :id (cthi/new-id! :mode-theme)
                      :group "Mode"
                      :name "Light"
                      :sets #{"Mode/Light"})
          mode-set (ctob/make-token-set
                    :id (cthi/new-id! :mode-set)
                    :name "Mode/Light")
          file (-> file
                   (update-in [:data :tokens-lib] ctob/add-set mode-set)
                   (update-in [:data :tokens-lib] ctob/add-theme mode-theme)
                   (activate-file-theme (ctob/get-id mode-theme)))
          store (ths/setup-store file)
          events [(sptm/activate-token-matrix-variant
                   "Device"
                   (cthi/id :desktop-set))]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')]
           (t/is (spts/theme-active? lib (cthi/id :desktop-theme)))
           (t/is (spts/theme-active? lib (cthi/id :mode-theme)))
           (t/is (not (spts/theme-active? lib (cthi/id :mobile-theme))))))))))

(t/deftest rename-matrix-variant-keeps-the-set-theme-pair-active
  (t/async
    done
    (let [file (-> (setup-file-with-matrix-token-lib)
                   (activate-file-theme (cthi/id :mobile-theme)))
          store (ths/setup-store file)
          events [(sptm/rename-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set)
                   "Phone")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')
               token-set (ctob/get-set lib (cthi/id :mobile-set))
               token-theme (ctob/get-theme lib (cthi/id :mobile-theme))]
           (t/is (= "Device/Phone" (ctob/get-name token-set)))
           (t/is (= "Phone" (:name token-theme)))
           (t/is (= #{"Device/Phone"} (:sets token-theme)))
           (t/is (spts/theme-active? lib (cthi/id :mobile-theme)))))))))

(t/deftest rename-matrix-domain-does-not-rename-an-unrelated-same-group-theme
  (t/async
    done
    (let [other-set (ctob/make-token-set
                     :id (cthi/new-id! :other-set)
                     :name "Other/Blue")
          other-theme (ctob/make-token-theme
                       :id (cthi/new-id! :other-theme)
                       :group "Device"
                       :name "Unrelated"
                       :sets #{"Other/Blue"})
          file (-> (setup-file-with-matrix-token-lib)
                   (update-in [:data :tokens-lib] ctob/add-set other-set)
                   (update-in [:data :tokens-lib] ctob/add-theme other-theme))
          store (ths/setup-store file)
          events [(sptm/rename-token-matrix-domain ["Device"] "Viewport")]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)
               theme (ctob/get-theme lib (cthi/id :other-theme))]
           (t/is (= "Device" (:group theme)))
           (t/is (= #{"Other/Blue"} (:sets theme)))
           (t/is (some? (ctob/get-set-by-name lib "Viewport/Mobile")))))))))

(t/deftest delete-matrix-domain-preserves-unrelated-and-mixed-themes
  (t/async
    done
    (let [other-set (ctob/make-token-set
                     :id (cthi/new-id! :other-set)
                     :name "Other/Blue")
          unrelated-theme (ctob/make-token-theme
                           :id (cthi/new-id! :other-theme)
                           :group "Device"
                           :name "Unrelated"
                           :sets #{"Other/Blue"})
          mixed-theme (ctob/make-token-theme
                       :id (cthi/new-id! :mixed-theme)
                       :group "Device"
                       :name "Mixed"
                       :sets #{"Device/Mobile" "Other/Blue"})
          file (-> (setup-file-with-matrix-token-lib)
                   (update-in [:data :tokens-lib] ctob/add-set other-set)
                   (update-in [:data :tokens-lib] ctob/add-theme unrelated-theme)
                   (update-in [:data :tokens-lib] ctob/add-theme mixed-theme))
          store (ths/setup-store file)
          events [(sptm/delete-token-matrix-domain ["Device"])]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [lib (-> new-state ths/get-file-from-state current-tokens-library)]
           (t/is (nil? (ctob/get-set-by-name lib "Device/Mobile")))
           (t/is (= #{"Other/Blue"}
                    (:sets (ctob/get-theme lib (cthi/id :other-theme)))))
           (t/is (= #{"Other/Blue"}
                    (:sets (ctob/get-theme lib (cthi/id :mixed-theme)))))))))))

(t/deftest deleting-the-active-matrix-variant-activates-the-first-remaining-column
  (t/async
    done
    (let [file (-> (setup-file-with-matrix-token-lib)
                   (activate-file-theme (cthi/id :mobile-theme)))
          store (ths/setup-store file)
          events [(sptm/delete-token-matrix-variant
                   "Device"
                   (cthi/id :mobile-set))]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)
               lib (current-tokens-library file')]
           (t/is (nil? (ctob/get-set lib (cthi/id :mobile-set))))
           (t/is (nil? (ctob/get-theme lib (cthi/id :mobile-theme))))
           (t/is (spts/theme-active? lib (cthi/id :desktop-theme)))))))))

(defn- watch-undo-stack
  []
  (ptk/reify ::watch-undo-stack
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper-s (->> stream (rx/filter (ptk/type? ::watch-undo-stack)))]
        (->> stream
             (rx/filter dch/commit?)
             (rx/map deref)
             (rx/mapcat
              (fn [{:keys [save-undo? undo-changes redo-changes undo-group
                           tags stack-undo? selected-before]}]
                (if (and save-undo? (seq undo-changes))
                  (rx/of (dwu/append-undo
                          {:undo-changes undo-changes
                           :redo-changes redo-changes
                           :undo-group undo-group
                           :tags tags
                           :selected-before selected-before}
                          stack-undo?))
                  (rx/empty))))
             (rx/take-until stopper-s))))))

(defn- setup-file-with-matrix-row-legacy
  []
  (let [light-set-id (cthi/new-id! :matrix-light-set)
        dark-set-id (cthi/new-id! :matrix-dark-set)
        light-token (ctob/make-token
                     {:id (cthi/new-id! :matrix-light-token)
                      :name "color.primary"
                      :type :color
                      :value "#ffffff"
                      :description "Primary"})
        dark-token (ctob/make-token
                    {:id (cthi/new-id! :matrix-dark-token)
                     :name "color.primary"
                     :type :color
                     :value "#000000"
                     :description "Primary"})
        light-alias (ctob/make-token
                     {:id (cthi/new-id! :matrix-light-alias)
                      :name "color.alias"
                      :type :color
                      :value "{color.primary}"})
        dark-alias (ctob/make-token
                    {:id (cthi/new-id! :matrix-dark-alias)
                     :name "color.alias"
                     :type :color
                     :value "{color.primary}"})
        tokens-lib (-> (ctob/make-tokens-lib)
                       (ctob/add-set (ctob/make-token-set
                                      :id light-set-id
                                      :name "Mode/Light"))
                       (ctob/add-set (ctob/make-token-set
                                      :id dark-set-id
                                      :name "Mode/Dark"))
                       (ctob/add-token light-set-id light-token)
                       (ctob/add-token light-set-id light-alias)
                       (ctob/add-token dark-set-id dark-token)
                       (ctob/add-token dark-set-id dark-alias))]
    (-> (setup-file)
        (ctho/add-rect :matrix-rect
                       {:applied-tokens {:fill "color.primary"}})
        (assoc-in [:data :tokens-lib] tokens-lib))))

(defn- matrix-row-definitions
  [file token-name]
  (let [tokens-lib (get-in file [:data :tokens-lib])]
    (mapv (fn [set-label]
            (let [set-id (cthi/id set-label)]
              {:set-id set-id
               :token (get (ctob/get-tokens tokens-lib set-id) token-name)}))
          [:matrix-light-set :matrix-dark-set])))

(defn- activate-light-matrix-theme-legacy
  [file]
  (let [light-theme (ctob/make-token-theme
                     :name "Light"
                     :group "Mode"
                     :sets #{"Mode/Light"})
        dark-theme (ctob/make-token-theme
                    :name "Dark"
                    :group "Mode"
                    :sets #{"Mode/Dark"})]
    (update-in file [:data :tokens-lib]
               #(-> %
                    (ctob/add-theme light-theme)
                    (ctob/add-theme dark-theme)
                    (spts/activate-theme (ctob/get-id light-theme))))))

(defn- activate-light-matrix-theme [file]
  (let [file (activate-light-matrix-theme-legacy file)]
    (assoc-in file [:data :tokens-status]
              (cfo/make-tokens-status-from-lib (get-in file [:data :tokens-lib])))))

(defn- setup-file-with-matrix-row
  []
  (let [file (setup-file-with-matrix-row-legacy)]
    (assoc-in file [:data :tokens-status]
              (cfo/make-tokens-status-from-lib (get-in file [:data :tokens-lib])))))

(t/deftest test-undo-transaction-keeps-explicit-group
  (t/testing "an undo transaction can join the user action that initiated it"
    (let [store (ptk/store {:state {}})
          transaction-id (js/Symbol)
          undo-group (random-uuid)]
      (ptk/emit! store
                 (dwu/start-undo-transaction
                  transaction-id
                  :timeout false
                  :undo-group undo-group))
      (t/is (= undo-group
               (get-in @store [:workspace-undo :transaction :undo-group]))))))

(t/deftest test-update-token-matrix-row-is-one-undo-entry
  (t/testing "renaming a matrix row updates every set and reference atomically"
    (t/async
      done
      (let [file (setup-file-with-matrix-row)
            store (ths/setup-store file)
            definitions (matrix-row-definitions file "color.primary")]
        (ptk/emit! store (watch-undo-stack))
        (tohs/run-store-async
         store done
         [(sptm/update-token-matrix-row
           definitions
           {:name "color.brand"
            :description "Brand color"})]
         (fn [new-state]
           (let [file' (ths/get-file-from-state new-state)
                 tokens-lib (get-in file' [:data :tokens-lib])
                 shape (cths/get-shape file' :matrix-rect)]
             (doseq [set-label [:matrix-light-set :matrix-dark-set]
                     :let [set-id (cthi/id set-label)
                           tokens (ctob/get-tokens tokens-lib set-id)]]
               (t/is (nil? (get tokens "color.primary")))
               (t/is (= "Brand color"
                        (:description (get tokens "color.brand"))))
               (t/is (= "{color.brand}"
                        (:value (get tokens "color.alias")))))
             (t/is (= "color.brand" (get-in shape [:applied-tokens :fill])))
             (t/is (= 1 (count (get-in new-state [:workspace-undo :items])))))))))))

(t/deftest test-delete-token-matrix-row-is-one-undo-entry
  (t/testing "deleting a matrix row removes every set definition atomically"
    (t/async
      done
      (let [file (setup-file-with-matrix-row)
            store (ths/setup-store file)
            definitions (matrix-row-definitions file "color.primary")]
        (ptk/emit! store (watch-undo-stack))
        (tohs/run-store-async
         store done
         [(sptm/delete-token-matrix-row definitions)]
         (fn [new-state]
           (let [tokens-lib (get-in (ths/get-file-from-state new-state)
                                    [:data :tokens-lib])]
             (doseq [set-label [:matrix-light-set :matrix-dark-set]
                     :let [set-id (cthi/id set-label)]]
               (t/is (nil? (get (ctob/get-tokens tokens-lib set-id)
                                "color.primary"))))
             (t/is (= 1 (count (get-in new-state [:workspace-undo :items])))))))))))

(t/deftest test-token-matrix-row-undo-and-redo-are-complete
  (t/testing "one undo and redo restore the complete matrix row and its references"
    (t/async
      done
      (let [file (setup-file-with-matrix-row)
            store (ths/setup-store file)
            definitions (matrix-row-definitions file "color.primary")
            update-event (sptm/update-token-matrix-row
                          definitions
                          {:name "color.brand"
                           :description "Brand color"})
            token-present?
            (fn [state token-name]
              (let [tokens-lib (current-tokens-library (ths/get-file-from-state state))]
                (every? (fn [set-label]
                          (let [set-id (cthi/id set-label)]
                            (some? (get (ctob/get-tokens tokens-lib set-id)
                                        token-name))))
                        [:matrix-light-set :matrix-dark-set])))]
        (ptk/emit! store (watch-undo-stack))
        (tohs/run-store-async
         store (fn []) [update-event]
         (fn [updated-state]
           (t/is (token-present? updated-state "color.brand"))
           (tohs/run-store-async
            store (fn []) [dwu/undo]
            (fn [undone-state]
              (t/is (token-present? undone-state "color.primary"))
              (t/is (not (token-present? undone-state "color.brand")))
              (t/is (= "color.primary"
                       (get-in (cths/get-shape
                                (ths/get-file-from-state undone-state)
                                :matrix-rect)
                               [:applied-tokens :fill])))
              (tohs/run-store-async
               store done [dwu/redo]
               (fn [redone-state]
                 (t/is (token-present? redone-state "color.brand"))
                 (t/is (not (token-present? redone-state "color.primary")))
                 (t/is (= "color.brand"
                          (get-in (cths/get-shape
                                   (ths/get-file-from-state redone-state)
                                   :matrix-rect)
                                  [:applied-tokens :fill])))))))))))))

(t/deftest test-token-value-propagation-undoes-with-the-edit
  (t/testing "one undo restores both a token value and its propagated shape value"
    (t/async
      done
      (let [file (activate-light-matrix-theme
                  (setup-file-with-matrix-row))
            file (assoc-in file
                           [:data :pages-index (cthf/current-page-id file)
                            :objects (cthi/id :matrix-rect) :fills]
                           [{:fill-color "#ffffff"
                             :fill-opacity 1}])
            store (ths/setup-store file)
            light-token (-> (matrix-row-definitions file "color.primary")
                            first
                            :token)
            undo-group (random-uuid)
            token-value
            (fn [state]
              (let [tokens-lib (get-in (ths/get-file-from-state state)
                                       [:data :tokens-lib])]
                (:value (ctob/get-token tokens-lib
                                        (cthi/id :matrix-light-set)
                                        (:id light-token)))))
            shape-fill
            (fn [state]
              (get-in (cths/get-shape (ths/get-file-from-state state)
                                      :matrix-rect)
                      [:fills 0 :fill-color]))]
        (ptk/emit! store (watch-undo-stack))
        (tohs/run-store-async
         store (fn [])
         [(dwtl/update-token
           (cthi/id :matrix-light-set)
           (:id light-token)
           {:value "#ff0000"}
           :undo-group undo-group)
          (dwtp/propagate-workspace-tokens undo-group)]
         (fn [updated-state]
           (t/is (= "#ff0000" (token-value updated-state)))
           (t/is (= "#ff0000" (shape-fill updated-state)))
           (t/is (= 2 (count (get-in updated-state
                                     [:workspace-undo :items]))))
           (t/is (every? #(= undo-group (:undo-group %))
                         (get-in updated-state [:workspace-undo :items])))
           (tohs/run-store-async
            store (fn []) [dwu/undo]
            (fn [undone-state]
              (t/is (= "#ffffff" (token-value undone-state)))
              (t/is (= "#ffffff" (shape-fill undone-state)))
              (tohs/run-store-async
               store done [dwu/redo]
               (fn [redone-state]
                 (t/is (= "#ff0000" (token-value redone-state)))
                 (t/is (= "#ff0000" (shape-fill redone-state)))))))))))))

(t/deftest test-matrix-theme-switch-undoes-with-propagation
  (t/testing "one undo restores the active matrix Theme and concrete shape value"
    (t/async
      done
      (let [file (activate-light-matrix-theme
                  (setup-file-with-matrix-row))
            file (assoc-in file
                           [:data :pages-index (cthf/current-page-id file)
                            :objects (cthi/id :matrix-rect) :fills]
                           [{:fill-color "#ffffff"
                             :fill-opacity 1}])
            store (ths/setup-store file)
            theme-active?
            (fn [state theme-name]
              (let [tokens-lib (current-tokens-library
                                (ths/get-file-from-state state))
                    theme (ctob/get-theme-by-name tokens-lib "Mode" theme-name)]
                (spts/theme-active? tokens-lib (ctob/get-id theme))))
            shape-fill
            (fn [state]
              (get-in (cths/get-shape (ths/get-file-from-state state)
                                      :matrix-rect)
                      [:fills 0 :fill-color]))]
        (ptk/emit! store (watch-undo-stack))
        (tohs/run-store-async
         store (fn [])
         [(sptm/activate-token-matrix-variant
           "Mode"
           (cthi/id :matrix-dark-set))]
         (fn [dark-state]
           (t/is (theme-active? dark-state "Dark"))
           (t/is (not (theme-active? dark-state "Light")))
           (t/is (= "#000000" (shape-fill dark-state)))
           (tohs/run-store-async
            store (fn []) [dwu/undo]
            (fn [light-state]
              (t/is (theme-active? light-state "Light"))
              (t/is (not (theme-active? light-state "Dark")))
              (t/is (= "#ffffff" (shape-fill light-state)))
              (tohs/run-store-async
               store done [dwu/redo]
               (fn [redone-state]
                 (t/is (theme-active? redone-state "Dark"))
                 (t/is (not (theme-active? redone-state "Light")))
                 (t/is (= "#000000" (shape-fill redone-state)))))))))))))

(t/deftest deleting-a-domain-keeps-individually-enabled-sets
  (t/async
    done
    (let [other-set (ctob/make-token-set
                     :id (cthi/new-id! :other-set)
                     :name "Other/Blue")
          file (-> (setup-file-with-matrix-token-lib)
                   (update-in [:data :tokens-lib] ctob/add-set other-set)
                   (assoc-in [:data :tokens-status]
                             (ctos/make-tokens-status
                              :active-set-ids #{(cthi/id :mobile-set)
                                                (cthi/id :other-set)})))
          store (ths/setup-store file)
          events [(sptm/delete-token-matrix-domain ["Device"])]]
      (tohs/run-store-async
       store done events
       (fn [new-state]
         (let [status (get-in (ths/get-file-from-state new-state)
                              [:data :tokens-status])]
           (t/is (= #{(cthi/id :other-set)} (ctos/get-active-set-ids status)))
           (t/is (empty? (ctos/get-active-theme-ids status)))))))))
