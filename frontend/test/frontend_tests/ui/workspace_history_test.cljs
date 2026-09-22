;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.workspace-history-test
  (:require
   [app.main.ui.workspace.sidebar.history :as history]
   [cljs.test :as t :include-macros true]))

(defn- token-entry
  [redo-attrs undo-attrs]
  {:redo-changes [{:type :set-token
                   :set-id (random-uuid)
                   :token-id (random-uuid)
                   :attrs redo-attrs}]
   :undo-changes [{:type :set-token
                   :set-id (random-uuid)
                   :token-id (random-uuid)
                   :attrs undo-attrs}]})

(t/deftest test-token-history-operation
  (t/are [expected redo-attrs undo-attrs]
         (= expected
            (-> (token-entry redo-attrs undo-attrs)
                (history/parse-entry)
                (first)
                (select-keys [:type :operation])))

    {:type :token :operation :new} {:name "color.brand"} nil
    {:type :token :operation :modify} {:name "color.brand"} {:name "color.primary"}
    {:type :token :operation :delete} nil {:name "color.primary"}))

(t/deftest test-token-library-history-types
  (t/are [expected-type change]
         (= expected-type (:type (history/parse-change change change)))

    :token-set {:type :set-token-set :id (random-uuid) :attrs {}}
    :token-theme {:type :set-token-theme :id (random-uuid) :attrs {}}
    :token-theme {:type :set-active-token-themes :theme-paths #{"Mode/Light"}}
    :token-set {:type :rename-token-set-group
                :set-group-path ["Mode"]
                :set-group-fname "Appearance"}))

(t/deftest test-multiple-token-changes-stay-token-history
  (let [changes [(history/parse-change
                  {:type :set-token :token-id (random-uuid) :attrs {}}
                  {:type :set-token :token-id (random-uuid) :attrs {}})
                 (history/parse-change
                  {:type :set-token :token-id (random-uuid) :attrs {}}
                  {:type :set-token :token-id (random-uuid) :attrs {}})]
        entry (history/select-entry changes)]
    (t/is (= :token (:type entry)))
    (t/is (= :multiple (:id entry)))
    (t/is (= :modify (:operation entry)))))

(t/deftest test-token-propagation-is-one-history-row
  (let [undo-group (random-uuid)
        token-id (random-uuid)
        shape-id (random-uuid)
        entries [{:undo-group undo-group
                  :redo-changes [{:type :set-token
                                  :token-id token-id
                                  :attrs {:value "#ff0000"}}]
                  :undo-changes [{:type :set-token
                                  :token-id token-id
                                  :attrs {:value "#ffffff"}}]}
                 {:undo-group undo-group
                  :redo-changes [{:type :mod-obj
                                  :id shape-id
                                  :operations []}]
                  :undo-changes [{:type :mod-obj
                                  :id shape-id
                                  :operations []}]}
                 {:undo-group (random-uuid)
                  :redo-changes [{:type :mod-page
                                  :id (random-uuid)}]
                  :undo-changes [{:type :mod-page
                                  :id (random-uuid)}]}]
        grouped (history/group-undo-entries entries)
        parsed (history/parse-entries grouped
                                      {shape-id {:id shape-id :type :rect}})]
    (t/is (= 2 (count grouped)))
    (t/is (= [:set-token :mod-obj]
             (mapv :type (:redo-changes (first grouped)))))
    (t/is (= [:mod-obj :set-token]
             (mapv :type (:undo-changes (first grouped)))))
    (t/is (= {:type :token
              :operation :modify}
             (select-keys (first parsed) [:type :operation])))))

(t/deftest test-matrix-set-and-theme-changes-stay-one-set-action
  (let [set-id (random-uuid)
        candidates [(history/parse-change
                     {:type :set-token-set :id set-id :attrs {}}
                     {:type :set-token-set :id set-id :attrs nil})
                    (history/parse-change
                     {:type :set-token-theme :id (random-uuid) :attrs {}}
                     {:type :set-token-theme :id (random-uuid) :attrs nil})
                    (history/parse-change
                     {:type :set-active-token-themes
                      :theme-paths #{"Mode/Light"}}
                     {:type :set-active-token-themes
                      :theme-paths #{}})]
        entry (history/select-entry candidates)]
    (t/is (= :token-set (:type entry)))
    (t/is (= :new (:operation entry)))
    (t/is (= set-id (:id entry)))))
