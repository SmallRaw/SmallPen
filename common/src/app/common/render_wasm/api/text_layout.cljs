;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.common.render-wasm.api.text-layout
  "Text measurement and resize rules shared by App and Node rendering."
  (:require
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.render-wasm.api.select :as select]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.types.modifiers :as modifiers]))

(defn get-dimensions
  ([]
   (when (wasm/ready?)
     (let [ptr (h/call wasm/internal-module "_get_text_dimensions")]
       (when-not (zero? ptr)
         (let [offset (mem/->offset-32 ptr)
               heap (mem/get-heap-f32)
               result {:width (aget heap offset) :height (aget heap (+ offset 1))
                       :max-width (aget heap (+ offset 2)) :x (aget heap (+ offset 3))
                       :y (aget heap (+ offset 4))}]
           (mem/free)
           result)))))
  ([id]
   (select/use-shape id)
   (get-dimensions)))

(defn new-size
  [{:keys [selrect grow-type]} dimension]
  (when (or (= :fixed grow-type) dimension)
    {:width (if (#{:fixed :auto-height} grow-type) (:width selrect) (:width dimension))
     :height (if (= :fixed grow-type) (:height selrect) (:height dimension))}))

(defn resize-modifiers
  [{:keys [points selrect] :as shape} size]
  (when size
    (modifiers/resize-modifiers
     (gpt/point (/ (:width size) (:width selrect)) (/ (:height size) (:height selrect)))
     (first points) (:transform shape (gmt/matrix)) (:transform-inverse shape (gmt/matrix)))))
