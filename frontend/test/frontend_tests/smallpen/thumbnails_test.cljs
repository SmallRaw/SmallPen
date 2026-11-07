;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.thumbnails-test
  "Board thumbnails wait for the viewport to measure SmallPen texts."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.workspace.thumbnails :as dwth]
   [app.main.rasterizer :as thr]
   [app.main.render :as render]
   [app.main.smallpen :as smallpen]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private frame-id (uuid/next))
(def ^:private text-id (uuid/next))

(defn- objects
  [text]
  {uuid/zero {:id uuid/zero :type :frame :shapes [frame-id]}
   frame-id  {:id frame-id :type :frame :parent-id uuid/zero :frame-id uuid/zero
              :shapes [text-id]}
   text-id   (merge {:id text-id :type :text :parent-id frame-id :frame-id frame-id}
                    text)})

(defn- rasterized?
  "Runs the board thumbnail pipeline and tells whether it reached the
  rasterizer."
  [objects]
  (let [state  {:files {file-id {:data {:pages-index {page-id {:objects objects}}}}}}
        calls  (atom 0)]
    ;; Multi-arity, so the direct arity call in the pipeline finds it.
    (with-redefs [render/render-frame (fn
                                        ([_ _ _] (rx/of {:data "<svg/>"}))
                                        ([_ _ _ _] (rx/of {:data "<svg/>"})))
                  thr/render          (fn [_] (swap! calls inc) (rx/of :blob))]
      (rx/subs! identity identity
                (#'dwth/render-thumbnail state file-id page-id frame-id "frame")))
    (pos? @calls)))

(def ^:private measured {:position-data [{:x 0 :y 0 :text "Card"}]})

(t/deftest unmeasured-text-is-a-smallpen-condition
  (t/is (false? (smallpen/unmeasured-text? (objects {}) frame-id))
        "upstream files always carry position-data")
  (with-redefs [smallpen/enabled? (constantly true)]
    (t/is (true? (smallpen/unmeasured-text? (objects {}) frame-id)))
    (t/is (false? (smallpen/unmeasured-text? (objects measured) frame-id)))))

;; Scenario: a package opens. Its texts carry no position-data until the
;; viewport measures them, so they render as a foreignObject, which taints
;; the rasterizer canvas ("Tainted canvases may not be exported").
(t/deftest board-thumbnail-waits-for-measured-texts
  (with-redefs [smallpen/enabled? (constantly true)]
    (t/is (false? (rasterized? (objects {}))))
    (t/is (true? (rasterized? (objects measured)))))
  (t/is (true? (rasterized? (objects {})))
        "outside SmallPen the pipeline is unchanged"))
