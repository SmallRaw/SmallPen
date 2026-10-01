;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.data.smallpen-interactions-test
  (:require
   [app.common.test-helpers.compositions :as ctho]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.shape.interactions :as ctsi]
   [app.main.data.workspace.interactions :as dwi]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.state :as ths]))

(t/use-fixtures :each
  {:before cthi/reset-idmap!})

(defn- make-smallpen-file
  "A SmallPen projected file (file-level SmallPen plugin data) with two
  boards on an ordinary source page."
  []
  (-> (cthf/sample-file :file1)
      (ctho/add-frame :board1 :name "Board 1")
      (ctho/add-frame :board2 :name "Board 2")
      (assoc :backend :smallpen)
      (assoc-in [:data :plugin-data :smallpen] {"package-id" "test"})))

(t/deftest smallpen-navigation-creates-a-persisted-flow
  (t/async
    done
    (let [file        (make-smallpen-file)
          board1-id   (:id (cths/get-shape file :board1))
          board2-id   (:id (cths/get-shape file :board2))
          page-id     (cthf/current-page-id file)
          interaction (-> ctsi/default-interaction
                          (ctsi/set-destination board2-id)
                          (assoc :position-relative-to board1-id))
          store       (ths/setup-store file)
          events      [(dwi/add-interaction page-id board1-id interaction)]]
      (ths/run-store
       store done events
       (fn [new-state]
         (let [data  (get-in new-state [:files (:current-file-id new-state) :data])
               shape (get-in data [:pages-index page-id :objects board1-id])
               flows (vals (get-in data [:pages-index page-id :flows]))]
           (t/is (= board2-id (get-in shape [:interactions 0 :destination]))
                 "the edit-policy gate lets source-page edits through")
           (t/is (= 1 (count flows))
                 "SmallPen keeps the Flow preview entry")
           (t/is (= board1-id (:starting-frame (first flows))))))))))
