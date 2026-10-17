;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.common.render-wasm.precision)

(defn- next-float32
  [value]
  (let [floats (js/Float32Array. 1)
        bits   (js/Uint32Array. (.-buffer floats))]
    (aset floats 0 value)
    (aset bits 0 (if (neg? value) (dec (aget bits 0)) (inc (aget bits 0))))
    (aget floats 0)))

(defn coordinate-tolerance
  "Error budget for a geometry round trip through f32 bounds and matrices.
  Four ULPs cover endpoint rounding and the matrix round trip. Keep the
  normal 0.001px floor; a fixed epsilon cannot work at all canvas positions."
  [coordinates]
  (reduce (fn [tolerance coordinate]
            (let [value (.fround js/Math (abs coordinate))
                  spacing (- (next-float32 value) value)]
              (if (js/Number.isFinite spacing)
                (max tolerance (* 4 spacing))
                tolerance)))
          0.001 coordinates))

(defn size-preserving-range
  "Convert bounds to f32 without shrinking their positive native size.
  Independent endpoint rounding can make an exact-fit text wrap at large x/y.
  Advance only the upper endpoint, by one representable f32 value when needed."
  [start end]
  (let [lower (.fround js/Math start)
        upper (.fround js/Math end)
        ;; The native dimension is f32 too. Double-only noise below its own
        ;; precision must not add a whole canvas-coordinate ULP on every row.
        size  (.fround js/Math (- end start))]
    [lower (if (and (js/Number.isFinite lower) (js/Number.isFinite upper)
                    (pos? size) (< (- upper lower) size))
             (next-float32 upper)
             upper)]))
