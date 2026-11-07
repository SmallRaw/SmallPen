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
   [app.common.math :as mth]
   [app.common.render-wasm.api.geometry :as geometry]
   [app.common.render-wasm.api.layout :as layout]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.scene :as serialize]
   [app.common.render-wasm.api.select :as select]
   [app.common.render-wasm.api.text-layout :as text-layout]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.node :as engine]
   [app.common.render-wasm.precision :as precision]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.types.modifiers :as modifiers]
   [app.common.types.shape :as shape]
   [app.common.types.shape.layout :as ctl]
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

(defn- visible-shape?
  [objects id]
  (loop [id id]
    (let [shape (get objects id)]
      (cond
        (:hidden shape) false
        (or (nil? shape) (= id uuid/zero)) true
        :else (recur (:parent-id shape))))))

(defn- upload-scene
  [objects opts]
  (serialize/serialize-scene! objects (assoc opts :include-layout? true))
  (doseq [[id shape] objects]
    (when (= :grid (:layout shape))
      (select/use-shape id)
      (layout/set-grid-layout shape)
      (layout/set-layout-data shape))
    (when (and (= :text (:type shape)) (visible-shape? objects id))
      (engine/update-text-layout! id))))

(defn- layout-entries
  [objects]
  (into []
        (keep (fn [[id shape]]
                (cond
                  (not (visible-shape? objects id)) nil
                  (and (= :text (:type shape)) (not= :fixed (:grow-type shape)))
                  (let [size (text-layout/new-size shape (text-layout/get-dimensions id))]
                    (when (and size
                               (or (not (mth/close? (:width size) (:width shape)))
                                   (not (mth/close? (:height size) (:height shape)))))
                      [id {:transform (modifiers/modifiers->transform
                                       (text-layout/resize-modifiers shape size))
                           :kind :child}]))
                  (:layout shape)
                  [id {:transform (matrix/matrix) :kind :parent}])))
        objects))

(defn- layout-change
  [before after]
  (let [tolerance (into {} (map (fn [axis]
                                  [axis (precision/coordinate-tolerance
                                         (map axis (concat (:points before) (:points after))))]))
                        [:x :y])
        deltas (concat (map (fn [[field axis]]
                              [axis (abs (- (get after field) (get before field)))])
                            [[:x :x] [:y :y] [:width :x] [:height :y]])
                       (mapcat (fn [a b] [[:x (abs (- (:x a) (:x b)))]
                                          [:y (abs (- (:y a) (:y b)))]])
                               (:points before) (:points after)))
        changed? (some (fn [[axis delta]]
                         (or (not (js/Number.isFinite delta))
                             (not (mth/close? delta 0 (get tolerance axis)))))
                       deltas)]
    (when (or changed?
              (not= (boolean (:flip-x before)) (boolean (:flip-x after)))
              (not= (boolean (:flip-y before)) (boolean (:flip-y after))))
      {:nodeId (str (:id before)) :name (:name before) :delta (apply max (map second deltas))
       :tolerance tolerance
       :constraints (select-keys before [:layout :layout-item-h-sizing :layout-item-v-sizing :grow-type])
       :before (select-keys before [:x :y :width :height :flip-x :flip-y])
       :after (select-keys after [:x :y :width :height :flip-x :flip-y])})))

(defn- settle-layout
  [objects opts]
  (loop [objects objects pass 0]
    (upload-scene objects opts)
    (let [transforms (geometry/propagate-modifiers (layout-entries objects) false nil)
          next (reduce (fn [objects [id transform]]
                         (update objects id shapes/apply-transform transform)) objects transforms)
          changes (into [] (keep (fn [[id shape]] (layout-change (get objects id) shape))) next)]
      (cond
        (empty? changes) objects
        (< pass 8) (recur next (inc pass))
        :else (throw (ex-info "Shared App layout did not settle"
                              {:code :layout-not-settled :passes (inc pass) :tolerance 0.001
                               :nodes (vec (take 20 (sort-by :delta > changes)))}))))))

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
                    :when (and (= :text (:type shape)) (visible-shape? objects id))
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
                     (mapcat #(tree-seq coll? seq %)
                             (keep (fn [[id shape]] (when (visible-shape? objects id) shape)) objects)))]
    (clj->js {:fonts faces :images images})))

(defn render-request
  [request]
  (let [{:keys [root-id objects]} (project-request request)]
    (upload-resources request)
    (let [objects (settle-layout objects {:for-export (boolean (unchecked-get request "forExport"))})
          ;; Crop only after text and native layout settle. A seed text box
          ;; may be 10px wide while its actual auto-width text is 120px.
          crop-id (some-> (unchecked-get request "cropNodeId") uuid/parse)
          crop-shape (get objects crop-id)
          objects (if crop-shape
                    (let [bounds (select-keys (rect/points->rect (:points crop-shape))
                                              [:x :y :width :height])
                          holder (get objects root-id)
                          holder (shape/setup-shape
                                  (merge (dissoc holder :points :selrect :transform :transform-inverse)
                                         bounds))]
                      (assoc objects root-id holder))
                    objects)
          _ (when crop-shape (upload-scene objects {:for-export (boolean (unchecked-get request "forExport"))}))
          _limits (when-not (unchecked-get request "measureOnly")
                    (let [bounds (rect/points->rect (:points (get objects root-id)))
                          scale (unchecked-get request "scale")
                          width (js/Math.ceil (* (:width bounds) scale))
                          height (js/Math.ceil (* (:height bounds) scale))]
                      (when (or (> width 8192) (> height 8192)
                                (> (* width height) (* 32 1024 1024)))
                        (throw (ex-info "Rendered image exceeds safety limits"
                                        {:code :render-size-exceeded :width width :height height
                                         :maxDimension 8192 :maxPixels (* 32 1024 1024)
                                         :correction "Reduce --scale or export a selected --element; layout dimensions stay unchanged"})))))
          bytes (when-not (unchecked-get request "measureOnly")
                  (engine/render-shape-raster root-id (unchecked-get request "scale") :png))]
      (engine/evict-images! engine/image-cache-size)
      #js {:bytes bytes
           :bounds (clj->js (into {} (map (fn [[id shape]]
                                            [(str id) (select-keys (rect/points->rect (:points shape))
                                                                   [:x :y :width :height])])) objects))
           :textMetrics (clj->js (into {} (keep (fn [[id shape]]
                                                  (when (and (= :text (:type shape)) (visible-shape? objects id))
                                                    [(str id) (text-layout/get-dimensions id)]))) objects))
           :geometry (clj->js (into {} (map (fn [[id shape]]
                                              [(str id) (select-keys shape [:x :y :width :height :flip-x :flip-y])]))
                                    objects))})))

(defn- sizing-shape
  "The layout fields of a SmallPen node, as the App's sizing rules read them."
  [id node]
  (let [value (fn [key] (some-> (unchecked-get node key) keyword))]
    {:id id
     :layout (value "layout")
     :layout-flex-dir (value "layout-flex-dir")
     :layout-item-h-sizing (value "layout-item-h-sizing")
     :layout-item-v-sizing (value "layout-item-v-sizing")
     :layout-item-absolute (true? (unchecked-get node "layout-item-absolute"))
     :hidden (false? (unchecked-get node "visible"))
     :shapes (vec (or (some-> (unchecked-get node "children") array-seq) []))}))

(defn fix-sizing
  "Applies the App's flex sizing rules to SmallPen nodes, as the App does
  after a layout edit: `children` lists containers whose children it checks
  (ctl/fix-child-sizing), then `parents` lists containers it checks against
  their children (ctl/fix-parent-sizing). Hidden and absolutely placed
  children take no room in the layout, so a parent is checked against the
  others only, as when shapes are put into a container in the App
  (ctl/change-v-sizing?). Returns {nodeId: {field: value}} for the sizings
  it changed."
  [request]
  (let [nodes   (unchecked-get request "nodes")
        objects (into {} (map (fn [id] [id (sizing-shape id (unchecked-get nodes id))]))
                      (js/Object.keys nodes))
        flex?   (fn [shape] (= :flex (:layout shape)))
        objects (reduce (fn [objects id]
                          (let [parent (get objects id)]
                            (if (flex? parent)
                              (let [children (map objects (:shapes parent))]
                                (reduce (fn [objects child]
                                          (update objects (:id child) #(ctl/fix-child-sizing parent children %)))
                                        objects (filter some? children)))
                              objects)))
                        objects
                        (some-> (unchecked-get request "children") array-seq))
        objects (reduce (fn [objects id]
                          (let [parent (get objects id)]
                            (if (flex? parent)
                              (update objects id ctl/fix-parent-sizing
                                      (->> (:shapes parent) (keep objects) (remove ctl/position-absolute?)))
                              objects)))
                        objects
                        (some-> (unchecked-get request "parents") array-seq))
        before  (fn [id key] (some-> (unchecked-get (unchecked-get nodes id) key) keyword))]
    (clj->js
     (into {}
           (keep (fn [[id shape]]
                   (let [changed (into {}
                                       (keep (fn [key]
                                               (let [value (get shape key)]
                                                 (when (and value (not= value (before id (name key))))
                                                   [(name key) (name value)]))))
                                       [:layout-item-h-sizing :layout-item-v-sizing])]
                     (when (seq changed) [id changed]))))
           objects))))
