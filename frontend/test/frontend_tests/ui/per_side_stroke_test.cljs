;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.ui.per-side-stroke-test
  (:require
   ["react-dom/server" :as rds]
   [app.common.types.shape :as cts]
   [app.main.ui.shapes.rect :as rect]
   [cljs.test :as t :include-macros true]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

(defn- render-stroke
  ([stroke] (render-stroke stroke {}))
  ([stroke shape-attrs]
   (let [shape (-> (cts/setup-shape {:type :rect :x 10 :y 20 :width 100 :height 60})
                   (merge shape-attrs)
                   (assoc :fills [] :strokes [(merge {:stroke-color "#3957d7"
                                                      :stroke-style :solid
                                                      :stroke-opacity 0.5}
                                                     stroke)]))]
     (rds/renderToStaticMarkup (mf/element rect/rect-shape #js {:shape shape})))))

(t/deftest single-side-strokes-paint-only-the-requested-band
  (doseq [[side expected] [[:stroke-width-top "M10,20H110V80H10ZM10,22H110V80H10Z"]
                           [:stroke-width-right "M10,20H110V80H10ZM10,20H108V80H10Z"]
                           [:stroke-width-bottom "M10,20H110V80H10ZM10,20H110V78H10Z"]
                           [:stroke-width-left "M10,20H110V80H10ZM12,20H110V80H12Z"]]]
    (let [markup (render-stroke {:stroke-width 0 side 2 :stroke-alignment :inner})]
      (t/is (str/includes? markup (str "d=\"" expected "\"")))
      (t/is (str/includes? markup "fill-rule=\"evenodd\""))
      (t/is (str/includes? markup "fill-opacity:0.5")))))

(t/deftest sides-inherit-the-base-width-and-preserve-explicit-zero
  (let [markup (render-stroke {:stroke-width 2 :stroke-width-top 0 :stroke-alignment :inner})]
    (t/is (str/includes? markup "d=\"M10,20H110V80H10ZM12,20H108V78H12Z\""))))

(t/deftest side-bands-respect-center-and-outer-alignment
  (doseq [[alignment expected] [[:center "M10,20H110V82H10ZM10,20H110V78H10Z"]
                                [:outer "M10,20H110V84H10ZM10,20H110V80H10Z"]]]
    (t/is (str/includes? (render-stroke {:stroke-width 0 :stroke-width-bottom 4
                                         :stroke-alignment alignment})
                         (str "d=\"" expected "\"")))))

(t/deftest rounded-side-bands-retain-the-shape-transform-and-curves
  (let [markup (render-stroke {:stroke-width 2 :stroke-width-bottom 4 :stroke-alignment :inner}
                              {:r1 8 :r2 8 :r3 8 :r4 8})]
    (t/is (str/includes? markup "A8,8"))
    (t/is (str/includes? markup "A6,4"))
    (t/is (str/includes? markup "transform="))))

(t/deftest uniform-strokes-keep-the-existing-svg-rendering
  (let [markup (render-stroke {:stroke-width 2 :stroke-alignment :center})]
    (t/is (str/includes? markup "stroke-width:2"))
    (t/is (not (str/includes? markup "fill-rule=\"evenodd\"")))))
