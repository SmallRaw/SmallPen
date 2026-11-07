;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.wasm
  "Exporter host binding for the shared Node WASM driver."
  (:require
   [app.common.render-wasm.node :as node]
   [app.wasm.enums]))

(def init! node/init!)
(def fonts-for-shape node/fonts-for-shape)
(def fonts-for-shapes node/fonts-for-shapes)
(def store-font! node/store-font!)
(def store-font-url! node/store-font-url!)
(def clear-fonts! node/clear-fonts!)
(def update-text-layout! node/update-text-layout!)
(def image-cached? node/image-cached?)
(def store-image-url! node/store-image-url!)
(def store-image! node/store-image!)
(def evict-images! node/evict-images!)
(def provision-fonts! node/provision-fonts!)
(def render-shape-raster node/render-shape-raster)
(def render-shape-pdf node/render-shape-pdf)
(def render-shape-svg node/render-shape-svg)
(def artifact-dir node/artifact-dir)
(def image-cache-size node/image-cache-size)
