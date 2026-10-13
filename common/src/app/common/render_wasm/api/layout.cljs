;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.common.render-wasm.api.layout
  "The App's flex/grid and layout-item setters, shared with Node export."
  (:require
   [app.common.data :as d]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.uuid :as uuid]))

(def ^:const GRID-LAYOUT-ROW-U8-SIZE 8)
(def ^:const GRID-LAYOUT-COLUMN-U8-SIZE 8)
(def ^:const GRID-LAYOUT-CELL-U8-SIZE 36)

(defn set-flex-layout
  [shape]
  (let [dir        (-> (get shape :layout-flex-dir :row)
                       (sr/translate-layout-flex-dir))
        gap        (get shape :layout-gap)
        row-gap    (get gap :row-gap 0)
        column-gap (get gap :column-gap 0)

        align-items     (-> (get shape :layout-align-items) sr/translate-layout-align-items)
        align-content   (-> (get shape :layout-align-content) sr/translate-layout-align-content)
        justify-items   (-> (get shape :layout-justify-items) sr/translate-layout-justify-items)
        justify-content (-> (get shape :layout-justify-content) sr/translate-layout-justify-content)
        wrap-type       (-> (get shape :layout-wrap-type) sr/translate-layout-wrap-type)

        padding         (get shape :layout-padding)
        padding-top     (get padding :p1 0)
        padding-right   (get padding :p2 0)
        padding-bottom  (get padding :p3 0)
        padding-left    (get padding :p4 0)]

    (h/call wasm/internal-module
            "_set_flex_layout_data"
            dir
            row-gap
            column-gap
            align-items
            align-content
            justify-items
            justify-content
            wrap-type
            padding-top
            padding-right
            padding-bottom
            padding-left)))

(defn set-grid-layout-data
  [shape]
  (let [dir        (-> (get shape :layout-grid-dir :row)
                       (sr/translate-layout-grid-dir))
        gap        (get shape :layout-gap)
        row-gap    (get gap :row-gap 0)
        column-gap (get gap :column-gap 0)

        align-items     (-> (get shape :layout-align-items) sr/translate-layout-align-items)
        align-content   (-> (get shape :layout-align-content) sr/translate-layout-align-content)
        justify-items   (-> (get shape :layout-justify-items) sr/translate-layout-justify-items)
        justify-content (-> (get shape :layout-justify-content) sr/translate-layout-justify-content)

        padding         (get shape :layout-padding)
        padding-top     (get padding :p1 0)
        padding-right   (get padding :p2 0)
        padding-bottom  (get padding :p3 0)
        padding-left    (get padding :p4 0)]

    (h/call wasm/internal-module
            "_set_grid_layout_data"
            dir
            row-gap
            column-gap
            align-items
            align-content
            justify-items
            justify-content
            padding-top
            padding-right
            padding-bottom
            padding-left)))

(defn set-grid-layout-rows
  [entries]
  ;; Only allocate when there are entries; an empty list would alloc 0 bytes.
  ;; The wasm side reads an empty buffer as zero rows.
  (when (seq entries)
    (let [size    (mem/get-alloc-size entries GRID-LAYOUT-ROW-U8-SIZE)
          offset  (mem/alloc size)
          dview   (mem/get-data-view)]

      (reduce (fn [offset {:keys [type value]}]
                (-> offset
                    (mem/write-u8 dview (sr/translate-grid-track-type type))
                    (+ 3) ;; padding
                    (mem/write-f32 dview value)
                    (mem/assert-written offset GRID-LAYOUT-ROW-U8-SIZE)))

              offset
              entries)))

  (h/call wasm/internal-module "_set_grid_rows"))

(defn set-grid-layout-columns
  [entries]
  ;; Only allocate when there are entries; an empty list would alloc 0 bytes.
  ;; The wasm side reads an empty buffer as zero columns.
  (when (seq entries)
    (let [size   (mem/get-alloc-size entries GRID-LAYOUT-COLUMN-U8-SIZE)
          offset (mem/alloc size)
          dview  (mem/get-data-view)]

      (reduce (fn [offset {:keys [type value]}]
                (-> offset
                    (mem/write-u8 dview (sr/translate-grid-track-type type))
                    (+ 3) ;; padding
                    (mem/write-f32 dview value)
                    (mem/assert-written offset GRID-LAYOUT-COLUMN-U8-SIZE)))
              offset
              entries)))

  (h/call wasm/internal-module "_set_grid_columns"))

(defn set-grid-layout-cells
  [cells]
  ;; Only allocate when there are cells; an empty collection would alloc 0
  ;; bytes. The wasm side reads an empty buffer as zero cells.
  (when (seq cells)
    (let [size    (mem/get-alloc-size cells GRID-LAYOUT-CELL-U8-SIZE)
          offset  (mem/alloc size)
          dview   (mem/get-data-view)]

      (reduce-kv (fn [offset _ cell]
                   (let [shape-id  (-> (get cell :shapes) first)]
                     (-> offset
                         (mem/write-i32 dview (get cell :row))
                         (mem/write-i32 dview (get cell :row-span))
                         (mem/write-i32 dview (get cell :column))
                         (mem/write-i32 dview (get cell :column-span))

                         (mem/write-u8 dview (sr/translate-align-self (get cell :align-self)))
                         (mem/write-u8 dview (sr/translate-justify-self (get cell :justify-self)))

                         ;; padding
                         (+ 2)

                         (mem/write-uuid dview (d/nilv shape-id uuid/zero))
                         (mem/assert-written offset GRID-LAYOUT-CELL-U8-SIZE))))

                 offset
                 cells)))

  (h/call wasm/internal-module "_set_grid_cells"))

(defn set-grid-layout
  [shape]
  (set-grid-layout-data shape)
  (set-grid-layout-rows (get shape :layout-grid-rows))
  (set-grid-layout-columns (get shape :layout-grid-columns))
  (set-grid-layout-cells (get shape :layout-grid-cells)))

(defn set-layout-data
  [shape]
  (let [margins       (get shape :layout-item-margin)
        margin-top    (get margins :m1 0)
        margin-right  (get margins :m2 0)
        margin-bottom (get margins :m3 0)
        margin-left   (get margins :m4 0)

        h-sizing      (-> (get shape :layout-item-h-sizing) sr/translate-layout-sizing)
        v-sizing      (-> (get shape :layout-item-v-sizing) sr/translate-layout-sizing)
        align-self    (-> (get shape :layout-item-align-self) sr/translate-align-self)

        max-h         (get shape :layout-item-max-h)
        has-max-h     (some? max-h)
        min-h         (get shape :layout-item-min-h)
        has-min-h     (some? min-h)
        max-w         (get shape :layout-item-max-w)
        has-max-w     (some? max-w)
        min-w         (get shape :layout-item-min-w)
        has-min-w     (some? min-w)
        is-absolute   (boolean (get shape :layout-item-absolute))
        z-index       (get shape :layout-item-z-index)]
    (h/call wasm/internal-module
            "_set_layout_data"
            margin-top
            margin-right
            margin-bottom
            margin-left
            h-sizing
            v-sizing
            has-max-h
            (d/nilv max-h 0)
            has-min-h
            (d/nilv min-h 0)
            has-max-w
            (d/nilv max-w 0)
            has-min-w
            (d/nilv min-w 0)

            (d/nilv align-self 0)
            is-absolute
            (d/nilv z-index 0))))
