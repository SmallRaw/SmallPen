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

(defn size-preserving-range
  "Convert bounds to f32 without shrinking their positive authored size.
  Independent endpoint rounding can make an exact-fit text wrap at large x/y.
  Advance only the upper endpoint, by one representable f32 value when needed."
  [start end]
  (let [lower (.fround js/Math start)
        upper (.fround js/Math end)
        size  (- end start)]
    [lower (if (and (js/Number.isFinite lower) (js/Number.isFinite upper)
                    (pos? size) (< (- upper lower) size))
             (next-float32 upper)
             upper)]))
