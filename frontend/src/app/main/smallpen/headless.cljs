;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.headless
  "Node entry for the App projector and its existing CPU WASM exporter."
  (:require
   [app.common.fonts :as fonts]
   [app.common.geom.matrix :as matrix]
   [app.common.geom.rect :as rect]
   [app.common.geom.shapes :as shapes]
   [app.common.render-wasm.api.geometry :as geometry]
   [app.common.render-wasm.api.layout :as layout]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.scene :as serialize]
   [app.common.render-wasm.api.select :as select]
   [app.common.render-wasm.api.text-layout :as text-layout]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.node :as engine]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.types.modifiers :as modifiers]
   [app.common.types.shape :as shape]
   [app.common.uuid :as uuid]
   [app.main.smallpen.projection :as projection]
   [app.render-wasm.api.enums]))

(defn initialize
  [module]
  (set! wasm/internal-module module)
  (h/call module "_init_headless" 0 0)
  (set! wasm/context-initialized? true))

(defn builtin-fonts
  []
  (clj->js fonts/local-fonts))

(defn error-details [error]
  (clj->js (ex-data error)))

(def ^:private catalog-families
  (into {} (map (juxt :id :variants)) fonts/catalog))

(defn- normalize-font
  [families span paragraph]
  (let [font-id (:font-id span (:font-id paragraph "sourcesanspro"))
        family (get families font-id (get catalog-families font-id (get families "sourcesanspro")))
        weight (:font-weight span (:font-weight paragraph "400"))
        style (:font-style span (:font-style paragraph "normal"))
        variant (fonts/closest-variant family weight style)]
    (fonts/with-variant-attributes span paragraph variant)))

(defn- normalize-content
  [families content]
  (update-in content [:children 0 :children]
             (fn [paragraphs]
               (mapv (fn [paragraph]
                       (let [normalized (normalize-font families paragraph {})]
                         (update normalized :children
                                 #(mapv (fn [span] (normalize-font families span normalized)) %))))
                     paragraphs))))

(defn- upload-resources
  [request]
  (engine/clear-fonts!)
  (doseq [face (array-seq (unchecked-get request "fonts"))]
    (engine/store-font! {:id (uuid/get-u32 (fonts/font-id->uuid (unchecked-get face "fontId")))
                         :fallback? (unchecked-get face "isFallback")
                         :emoji? (unchecked-get face "isEmoji")
                         :weight (unchecked-get face "weight")
                         :style (if (= "italic" (unchecked-get face "style")) 1 0)}
                        (unchecked-get face "bytes")))
  (doseq [image (array-seq (unchecked-get request "images"))]
    (let [id (uuid/parse (unchecked-get image "id"))
          bytes (if-let [svg (unchecked-get image "svg")]
                  (let [svg-shape (shape/setup-shape
                                   {:id id :type :svg-raw :name "SVG image" :x 0 :y 0
                                    :width (unchecked-get image "width")
                                    :height (unchecked-get image "height")})]
                    (serialize/serialize-scene! {id svg-shape})
                    (select/use-shape id)
                    (props/set-shape-svg-raw-content svg)
                    (engine/render-shape-raster id 1 :png))
                  (unchecked-get image "bytes"))]
      (engine/store-image! id bytes))))

(defn- upload-scene
  [objects opts]
  (serialize/serialize-scene! objects (assoc opts :include-layout? true))
  (doseq [[id shape] objects]
    (when (= :grid (:layout shape))
      (select/use-shape id)
      (layout/set-grid-layout shape)
      (layout/set-layout-data shape))
    (when (= :text (:type shape))
      (engine/update-text-layout! id))))

(defn- layout-entries
  [objects]
  (into []
        (keep (fn [[id shape]]
                (cond
                  (and (= :text (:type shape)) (not= :fixed (:grow-type shape)))
                  (let [size (text-layout/new-size shape (text-layout/get-dimensions id))]
                    (when (and size
                               (or (> (abs (- (:width size) (:width shape))) 0.0001)
                                   (> (abs (- (:height size) (:height shape))) 0.0001)))
                      [id {:transform (modifiers/modifiers->transform
                                       (text-layout/resize-modifiers shape size))
                           :kind :child}]))
                  (:layout shape)
                  [id {:transform (matrix/matrix) :kind :parent}])))
        objects))

(defn- settle-layout
  [objects opts]
  (loop [objects objects pass 0]
    (upload-scene objects opts)
    (let [transforms (geometry/propagate-modifiers (layout-entries objects) false nil)
          next (reduce (fn [objects [id transform]]
                         (update objects id shapes/apply-transform transform)) objects transforms)
          changed? (some (fn [[id shape]]
                           (some #(> (abs (- (get shape %) (get-in objects [id %]))) 0.0001)
                                 [:x :y :width :height])) next)]
      (cond
        (not changed?) objects
        (< pass 8) (recur next (inc pass))
        :else (throw (ex-info "Shared App layout did not settle" {:code :layout-not-settled}))))))

(defn- project-request
  [request]
  (let [snapshot (js->clj (unchecked-get request "snapshot") :keywordize-keys true)
        nodes (js->clj (unchecked-get request "nodes") :keywordize-keys true)
        root-id (unchecked-get request "rootId")
        node-ids (js->clj (unchecked-get request "nodeIds") :keywordize-keys true)
        families (into {}
                       (map (fn [family]
                              [(unchecked-get family "fontId")
                               (js->clj (unchecked-get family "variants") :keywordize-keys true)]))
                       (array-seq (unchecked-get request "fontFamilies")))
        {:keys [root-id objects]} (projection/project-render-tree snapshot nodes root-id node-ids)
        objects (into {}
                      (map (fn [[id shape]]
                             [id (cond-> shape
                                   (= :text (:type shape))
                                   (update :content #(normalize-content families %)))]))
                      objects)]
    {:root-id root-id :objects objects}))

(defn describe-request
  [request]
  (let [{:keys [objects]} (project-request request)
        spans (for [[id shape] objects
                    :when (= :text (:type shape))
                    paragraph (get-in shape [:content :children 0 :children])
                    span (:children paragraph)]
                {:nodeId (str id) :family (:font-family span (:font-family paragraph)) :fontId (:font-id span (:font-id paragraph "sourcesanspro"))
                 :weight (js/Number (:font-weight span "400"))
                 :style (:font-style span "normal") :text (:text span)})
        text (apply str (map :text spans))
        fallbacks (map (fn [font]
                         {:fontId (:font-id font) :weight (:weight font)
                          :style (if (zero? (:style font)) "normal" "italic")
                          :isFallback true :isEmoji (boolean (:is-emoji font))})
                       (fonts/fallback-fonts-for-text text))
        faces (map (fn [span]
                     (assoc span :url (fonts/resolve-ttf-url
                                       (fonts/font-id->uuid (:fontId span))
                                       (:weight span) (if (= "italic" (:style span)) 1 0))))
                   (concat spans fallbacks))
        images (into #{} (keep #(some-> (or (:fill-image %) (:stroke-image %) (when (= :image (:type %)) (:metadata %))) :id str))
                     (mapcat #(tree-seq coll? seq %) (vals objects)))]
    (clj->js {:fonts faces :images images})))

(defn render-request
  [request]
  (let [{:keys [root-id objects]} (project-request request)]
    (upload-resources request)
    (let [objects (settle-layout objects {:for-export (boolean (unchecked-get request "forExport"))})
          bytes (when-not (unchecked-get request "measureOnly")
                  (engine/render-shape-raster root-id (unchecked-get request "scale") :png))]
      (engine/evict-images! engine/image-cache-size)
      #js {:bytes bytes
           :bounds (clj->js (into {} (map (fn [[id shape]]
                                            [(str id) (select-keys (rect/points->rect (:points shape))
                                                                   [:x :y :width :height])])) objects))
           :textMetrics (clj->js (into {} (keep (fn [[id shape]]
                                                  (when (= :text (:type shape))
                                                    [(str id) (text-layout/get-dimensions id)]))) objects))
           :geometry (clj->js (into {} (map (fn [[id shape]]
                                              [(str id) (select-keys shape [:x :y :width :height])]))
                                    objects))})))
