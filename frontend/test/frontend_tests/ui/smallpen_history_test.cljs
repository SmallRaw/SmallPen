;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.ui.smallpen-history-test
  (:require
   [app.main.smallpen :as smallpen]
   [app.main.smallpen.ui.history :as sp-history]
   [app.main.ui.workspace.sidebar.history :as history]
   [cljs.test :as t :include-macros true]))

(def ^:private enabled? smallpen/enabled?)

;; Token history rows exist only in SmallPen.
(t/use-fixtures :each
  {:before #(set! smallpen/enabled? (constantly true))
   :after  #(set! smallpen/enabled? enabled?)})

(t/deftest parse-entry-pairs-undo-changes-by-type-and-id
  (t/testing "a change-parent entry: one redo move undone by several changes"
    (let [set-id   (random-uuid)
          token-id (random-uuid)
          entry    {:redo-changes [{:type :mov-objects
                                    :parent-id (random-uuid)
                                    :shapes [(random-uuid)]}
                                   {:type :set-token
                                    :set-id set-id
                                    :token-id token-id
                                    :attrs {:name "color.brand"}}]
                    :undo-changes [{:type :set-token
                                    :set-id set-id
                                    :token-id token-id
                                    :attrs {:name "color.primary"}}
                                   {:type :mov-objects :shapes [(random-uuid)]}
                                   {:type :mod-obj :id (random-uuid) :operations []}
                                   {:type :mod-obj :id (random-uuid) :operations []}]}
          parsed   (history/parse-entry entry)]
      (t/is (= 2 (count parsed)))
      (t/is (= [:shape :token] (mapv :type parsed)))
      (t/is (= :modify (:operation (second parsed))))))

  (t/testing "a redo change without undo changes of its type"
    (let [entry {:redo-changes [{:type :mod-obj :id (random-uuid) :operations []}
                                {:type :set-token
                                 :set-id (random-uuid)
                                 :token-id (random-uuid)
                                 :attrs {:name "color.brand"}}]
                 :undo-changes []}]
      (t/is (= [:shape :token] (mapv :type (history/parse-entry entry))))))

  (t/testing "token changes match their own undo change by id"
    (let [set-id (random-uuid)
          a-id   (random-uuid)
          b-id   (random-uuid)
          entry  {:redo-changes [{:type :set-token :set-id set-id :token-id a-id
                                  :attrs {:name "a"}}
                                 {:type :set-token :set-id set-id :token-id b-id
                                  :attrs {:name "b"}}]
                  ;; Undo changes in the same order as the redo changes, so
                  ;; a pairing by position would swap them.
                  :undo-changes [{:type :set-token :set-id set-id :token-id a-id
                                  :attrs {:name "old-a"}}
                                 {:type :set-token :set-id set-id :token-id b-id
                                  :attrs nil}]}]
      (t/is (= [:modify :new]
               (mapv :operation (history/parse-entry entry)))))))

(t/deftest index-undo-entries-keeps-one-row-per-entry
  (let [group   (random-uuid)
        entries [{:undo-group group :redo-changes [] :undo-changes []}
                 {:undo-group group :redo-changes [] :undo-changes []}]
        indexed (sp-history/index-undo-entries entries)]
    (t/is (= 2 (count indexed)))
    (t/is (= [0 1] (mapv ::sp-history/start-index indexed)))
    (t/is (= [0 1] (mapv ::sp-history/end-index indexed)))))
