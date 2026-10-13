;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.common.render-wasm.api.geometry
  "Portable WASM layout propagation, shared by the App and Node renderer."
  (:require
   [app.common.geom.matrix :as matrix]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.mem.heap32 :as heap]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.uuid :as uuid]))

(defn read-modifier-entry
  [heapu32 heapf32 offset]
  [(uuid/from-unsigned-parts (aget heapu32 offset) (aget heapu32 (+ offset 1))
                             (aget heapu32 (+ offset 2)) (aget heapu32 (+ offset 3)))
   (matrix/matrix (aget heapf32 (+ offset 4)) (aget heapf32 (+ offset 5))
                  (aget heapf32 (+ offset 6)) (aget heapf32 (+ offset 7))
                  (aget heapf32 (+ offset 8)) (aget heapf32 (+ offset 9)))])

(defn propagate-modifiers
  [entries snap-pixel? snap-ignore-axis]
  (if-not (and (wasm/ready?) (seq entries))
    []
    (let [offset (mem/alloc->offset-32 (* 44 (count entries)))
          heapf32 (mem/get-heap-f32)
          heapu32 (mem/get-heap-u32)]
      (reduce (fn [offset [id {:keys [transform kind]}]]
                (-> offset
                    (heap/write-uuid heapu32 id)
                    (heap/write-matrix heapf32 transform)
                    (heap/write-u32 heapu32 (sr/translate-transform-entry-kind kind))))
              offset entries)
      (let [precision (cond (not snap-pixel?) 0
                            (= :x snap-ignore-axis) 3
                            (= :y snap-ignore-axis) 2
                            :else 1)
            offset (mem/->offset-32 (h/call wasm/internal-module "_propagate_modifiers" precision))
            heapf32 (mem/get-heap-f32)
            heapu32 (mem/get-heap-u32)
            length (aget heapu32 offset)
            result (mapv #(read-modifier-entry heapu32 heapf32 (+ offset 1 (* % 10)))
                         (range length))]
        (mem/free)
        result))))
