;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.data.workspace-modifiers-test
  (:require
   [app.common.files.helpers :as cfh]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.test-helpers.compositions :as ctho]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.component :as ctk]
   [app.common.types.modifiers :as ctm]
   [app.main.data.workspace.modifiers :as dwm]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.mock :as mock]))

(t/use-fixtures :each
  {:before cthi/reset-idmap!})

(defn- move-inputs
  [ids]
  (let [delta (gpt/point 17 23)]
    {:modifiers (dwm/create-modif-tree ids (ctm/move-modifiers delta))
     :transforms (into {} (map #(vector % (gmt/translate-matrix delta))) ids)}))

(defn- check-transform-budget
  [objects ids expected]
  (let [{:keys [modifiers transforms]} (move-inputs ids)
        svg-calls (atom {})
        wasm-calls (atom {})
        transform-shape gsh/transform-shape
        apply-transform gsh/apply-transform]
    ;; This guards work per operation, rather than elapsed time, so slower
    ;; test machines do not fail. Both paths still use real geometry math.
    (with-redefs [gsh/transform-shape
                  (mock/stub
                   (fn [shape modifiers]
                     (swap! svg-calls update (:id shape) (fnil inc 0))
                     (transform-shape shape modifiers)))
                  gsh/apply-transform
                  (mock/stub
                   (fn [shape transform]
                     (swap! wasm-calls update (:id shape) (fnil inc 0))
                     (apply-transform shape transform)))]
      (t/is (= expected (dwm/calculate-ignore-tree modifiers objects)))
      (t/is (= expected (dwm/calculate-ignore-tree-wasm transforms objects))))
    (t/is (every? #(= 1 %) (vals @svg-calls))
          "SVG geometry is prepared at most once per shape")
    (t/is (every? #(= 1 %) (vals @wasm-calls))
          "WASM commit geometry is prepared at most once per shape")
    (when (nil? expected)
      (t/is (empty? @svg-calls) "Ordinary shapes need no component geometry check")
      (t/is (empty? @wasm-calls) "Ordinary shapes need no component geometry check"))))

(t/deftest ordinary-transforms-skip-component-geometry
  (let [file (ctho/add-frame-with-child (cthf/sample-file :file1) :frame :rect)
        objects (:objects (cthf/current-page file))
        ids (cfh/get-children-ids-with-self objects (:id (cths/get-shape file :frame)))]
    (check-transform-budget objects ids nil)))

(t/deftest expanded-component-transforms-reuse-shape-geometry
  (let [children (mapv #(keyword (str "child-" %)) (range 32))
        file (ctho/add-component-with-many-children-and-copy
              (cthf/sample-file :file1) :component :main children :copy)
        objects (:objects (cthf/current-page file))
        ids (cfh/get-children-ids-with-self objects (:id (cths/get-shape file :copy)))]
    (check-transform-budget objects ids (zipmap ids (repeat true)))))

(t/deftest nested-component-translations-keep-geometry-untouched
  (let [file (ctho/add-nested-component-with-copy
              (cthf/sample-file :file1)
              :inner :inner-main :inner-child
              :outer :outer-main :nested :copy)
        objects (:objects (cthf/current-page file))
        ids (cfh/get-children-ids-with-self objects (:id (cths/get-shape file :copy)))
        copies (filter #(ctk/in-component-copy? (get objects %)) ids)]
    (check-transform-budget objects ids (zipmap copies (repeat true)))))

(t/deftest independent-component-child-movement-still-touches-geometry
  (let [file (ctho/add-simple-component-with-copy
              (cthf/sample-file :file1) :component :main :child :copy)
        objects (:objects (cthf/current-page file))
        child-id (first (:shapes (cths/get-shape file :copy)))
        {:keys [modifiers transforms]} (move-inputs [child-id])]
    (t/is (= {child-id false} (dwm/calculate-ignore-tree modifiers objects)))
    (t/is (= {child-id false} (dwm/calculate-ignore-tree-wasm transforms objects)))))

(t/deftest later-transforms-do-not-reuse-earlier-component-geometry
  (let [file (ctho/add-simple-component-with-copy
              (cthf/sample-file :file1) :component :main :child :copy)
        objects (:objects (cthf/current-page file))
        root-id (:id (cths/get-shape file :copy))
        child-id (first (:shapes (get objects root-id)))
        ids [root-id child-id]]
    (doseq [[selected expected] [[ids {root-id true child-id true}]
                                 [[child-id] {child-id false}]
                                 [ids {root-id true child-id true}]]]
      (let [{:keys [modifiers transforms]} (move-inputs selected)]
        (t/is (= expected (dwm/calculate-ignore-tree modifiers objects)))
        (t/is (= expected (dwm/calculate-ignore-tree-wasm transforms objects)))))))
