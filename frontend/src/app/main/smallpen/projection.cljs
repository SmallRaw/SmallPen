;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.projection
  (:require
   [app.common.data :as d]
   [app.common.features :as features]
   [app.common.files.tokens :as cfo]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.math :as mth]
   [app.common.path-names :as cpn]
   [app.common.types.file :as ctf]
   [app.common.types.page :as ctp]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.variant :as ctv]
   [app.common.uuid :as uuid]
   [app.main.smallpen.token-state :as spts]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [shadow.resource :as rc]))

(def format-capabilities
  "The Web projection capabilities the Background must report. Generated from
  SmallPen core (npm run build:web-capabilities), never kept by hand here."
  (js->clj (js/JSON.parse (rc/inline "./web_capabilities.json")) :keywordize-keys true))

(defn- validate-capabilities!
  [snapshot]
  (let [remote (get-in snapshot [:formatCapabilities :webProjection])]
    (when-not (= format-capabilities remote)
      (throw (ex-info "SmallPen Web projection capabilities do not match Background"
                      {:type :validation
                       :code :smallpen-capability-mismatch
                       :expected format-capabilities
                       :actual remote})))))

(defn- lookup
  [data key]
  (or (get data key)
      (when (string? key)
        (get data (keyword key)))))

(defn- runtime-id
  [snapshot kind & stable-path]
  (let [value (reduce lookup (get-in snapshot [:runtime kind]) stable-path)]
    (when-not (string? value)
      (throw (ex-info (str "SmallPen runtime id is missing: "
                           kind " " (pr-str (vec stable-path)))
                      {:kind kind :stable-path (vec stable-path)})))
    (uuid/parse value)))

(defn- referenced-asset
  [snapshot reference]
  (if (map? reference)
    (let [package-id (lookup reference "packageId")
          asset-id   (lookup reference "assetId")
          owner      (if (= package-id (get-in snapshot [:manifest :packageId]))
                       snapshot
                       (some (fn [library]
                               (when (= package-id
                                        (get-in library [:manifest :packageId]))
                                 library))
                             (:libraries snapshot)))]
      (when-not owner
        (throw (ex-info (str "SmallPen Library is unavailable: " package-id)
                        {:type :validation
                         :code :missing-smallpen-library
                         :package-id package-id})))
      {:asset-id asset-id
       :file-id  (-> owner :runtime :file uuid/parse)
       :owner    owner})
    {:asset-id reference
     :file-id  (-> snapshot :runtime :file uuid/parse)
     :owner    snapshot}))

(defn- node-type
  [value]
  (case value
    "COMPONENT" :frame
    "ELLIPSE" :circle
    "FRAME" :frame
    "GROUP" :group
    "IMAGE" :image
    "INSTANCE" :frame
    "PATH" :path
    "RECTANGLE" :rect
    "TEXT" :text
    (throw (ex-info "unsupported SmallPen node type"
                    {:type :validation
                     :code :unsupported-smallpen-node-type
                     :node-type value}))))

(defn- project-gradient
  [{:keys [endX endY gradientWidth startX startY stops type]}]
  {:type (case type
           "linear-gradient" :linear
           "radial-gradient" :radial
           (throw (ex-info "unsupported SmallPen gradient type"
                           {:type :validation
                            :code :unsupported-smallpen-gradient-type
                            :gradient-type type})))
   :start-x startX
   :start-y startY
   :end-x endX
   :end-y endY
   :width gradientWidth
   :stops (mapv (fn [{:keys [color offset opacity]}]
                  (cond-> {:color color :offset offset}
                    (number? opacity) (assoc :opacity opacity)))
                stops)})

(defn- media-asset
  [snapshot media-id]
  (let [entry (first (get-in snapshot [:manifest :entries :assets]))
        media (some->> entry
                       (lookup (:entries snapshot))
                       (:media)
                       (some #(when (= media-id (:id %)) %)))]
    (or media
        (throw (ex-info "missing SmallPen Media asset"
                        {:type :validation
                         :code :missing-smallpen-media
                         :media-id media-id})))))

(defn- project-media-reference
  [snapshot media-reference]
  (let [{:keys [asset-id owner]} (referenced-asset snapshot media-reference)
        {:keys [height mimeType name width]} (media-asset owner asset-id)]
    {:id (runtime-id owner :media asset-id)
     :height height
     :keep-aspect-ratio true
     :mtype mimeType
     :name name
     :width width}))

(defn- project-fills
  [snapshot values]
  (mapv (fn [{:keys [color colorRef opacity type] :as fill}]
          (when-not (contains? #{"image" "linear-gradient" "radial-gradient" "solid"}
                               type)
            (throw (ex-info "unsupported SmallPen fill type"
                            {:type :validation
                             :code :unsupported-smallpen-fill-type
                             :fill-type type})))
          (cond-> {:fill-opacity (or opacity 1)}
            (= type "solid")
            (assoc :fill-color color)

            (= type "image")
            (assoc :fill-image (project-media-reference snapshot
                                                        (:mediaRef fill)))

            (or (= type "linear-gradient")
                (= type "radial-gradient"))
            (assoc :fill-color-gradient (project-gradient fill))

            (some? colorRef)
            (merge (let [{:keys [asset-id file-id owner]}
                         (referenced-asset snapshot colorRef)]
                     {:fill-color-ref-file file-id
                      :fill-color-ref-id (runtime-id owner :colors asset-id)}))))
        values))

(defn- project-strokes
  [snapshot values]
  (mapv (fn [{:keys [alignment capEnd capStart color dash gap hidden opacity
                     colorRef style type width widthTop widthRight widthBottom
                     widthLeft] :as stroke}]
          (when-not (contains? #{"image" "linear-gradient" "radial-gradient" "solid"}
                               type)
            (throw (ex-info "unsupported SmallPen stroke type"
                            {:type :validation
                             :code :unsupported-smallpen-stroke-type
                             :stroke-type type})))
          (cond-> {:stroke-alignment (keyword (or alignment "inner"))
                   :stroke-opacity (or opacity 1)
                   :stroke-style (keyword (or style "solid"))
                   :stroke-width (or width 1)}
            ;; Per-side widths; a missing side uses the stroke width.
            (some some? [widthTop widthRight widthBottom widthLeft])
            (assoc :stroke-width-top (or widthTop width 1)
                   :stroke-width-right (or widthRight width 1)
                   :stroke-width-bottom (or widthBottom width 1)
                   :stroke-width-left (or widthLeft width 1))

            (= type "solid")
            (assoc :stroke-color color)

            (= type "image")
            (assoc :stroke-image (project-media-reference snapshot
                                                          (:mediaRef stroke)))

            (or (= type "linear-gradient")
                (= type "radial-gradient"))
            (assoc :stroke-color-gradient (project-gradient stroke))

            (some? capStart) (assoc :stroke-cap-start (keyword capStart))
            (some? capEnd) (assoc :stroke-cap-end (keyword capEnd))
            (number? dash) (assoc :stroke-dash dash)
            (number? gap) (assoc :stroke-gap gap)
            (some? hidden) (assoc :hidden hidden)
            (some? colorRef)
            (merge (let [{:keys [asset-id file-id owner]}
                         (referenced-asset snapshot colorRef)]
                     {:stroke-color-ref-file file-id
                      :stroke-color-ref-id (runtime-id owner :colors asset-id)}))))
        values))

(defn- project-corner-radius
  [value]
  (cond
    (number? value)
    [value value value value]

    (and (vector? value)
         (= 4 (count value))
         (every? number? value))
    value

    :else
    (throw (ex-info "unsupported SmallPen corner radius"
                    {:type :validation
                     :code :unsupported-smallpen-corner-radius
                     :corner-radius value}))))

(def ^:private default-text-style
  {:fontFamily "sourcesanspro"
   :fontId "sourcesanspro"
   :fontSize 14
   :fontStyle "normal"
   :fontVariantId "regular"
   :fontWeight 400
   :letterSpacing 0
   :lineHeight 1.2
   :textAlign "left"
   :textDecoration "none"
   :textDirection "ltr"
   :textTransform "none"
   :verticalAlign "top"})

(def ^:private built-in-font-family-ids
  #{"sourcesanspro"})

(defn- font-identity
  [value]
  (some-> value
          (str/lower)
          (str/replace #"[^a-z0-9]" "")))

(defn- project-font-id
  [snapshot font-id font-family]
  (let [family-id (font-identity font-family)]
    (cond
      (contains? built-in-font-family-ids family-id)
      family-id

      (lookup (get-in snapshot [:runtime :fonts]) font-id)
      (str "custom-" (lookup (get-in snapshot [:runtime :fonts]) font-id))

      :else
      font-id)))

(def ^:private source-sans-pro-variants
  {[200 "normal"] "200"
   [200 "italic"] "200italic"
   [300 "normal"] "300"
   [300 "italic"] "300italic"
   [400 "normal"] "regular"
   [400 "italic"] "italic"
   [600 "normal"] "600"
   [600 "italic"] "600italic"
   [700 "normal"] "bold"
   [700 "italic"] "bolditalic"
   [900 "normal"] "black"
   [900 "italic"] "blackitalic"})

(defn- project-font-variant-id
  [font-id font-variant-id font-weight font-style]
  (if (= font-id "sourcesanspro")
    (get source-sans-pro-variants
         [font-weight font-style]
         font-variant-id)
    font-variant-id))

(defn- project-text-span
  [snapshot text fills style]
  (let [{:keys [fontFamily fontId fontSize fontStyle fontVariantId fontWeight
                letterSpacing lineHeight textDecoration textTransform
                typographyRef]} style
        projected-font-id (project-font-id snapshot fontId fontFamily)]
    (cond-> {:fills fills
             :font-family fontFamily
             :font-id projected-font-id
             :font-size (str fontSize)
             :font-style fontStyle
             :font-variant-id (project-font-variant-id projected-font-id
                                                       fontVariantId
                                                       fontWeight
                                                       fontStyle)
             :font-weight (str fontWeight)
             :letter-spacing (str letterSpacing)
             :line-height (str lineHeight)
             :text text
             :text-decoration textDecoration
             :text-transform textTransform}
      (some? typographyRef)
      (merge (let [{:keys [asset-id file-id owner]}
                   (referenced-asset snapshot typographyRef)]
               {:typography-ref-file file-id
                :typography-ref-id
                (runtime-id owner :typographies asset-id)})))))

(defn- project-text-content
  [snapshot text fills text-style text-blocks]
  (let [base-style (merge default-text-style text-style)
        base-fills (if (seq fills)
                     (project-fills snapshot fills)
                     [{:fill-color "#000000" :fill-opacity 1}])
        blocks     (if (seq text-blocks)
                     text-blocks
                     (mapv (fn [line]
                             {:runs [{:text line}]})
                           (.split text "\n")))
        paragraphs (mapv
                    (fn [{:keys [runs textStyle]}]
                      (let [block-style (merge base-style textStyle)
                            {:keys [lineHeight textAlign textDirection]} block-style]
                        {:type "paragraph"
                         :line-height (str lineHeight)
                         :text-align textAlign
                         :text-direction textDirection
                         :children
                         (mapv (fn [{:keys [fills text textStyle]}]
                                 (project-text-span
                                  snapshot
                                  text
                                  (if (seq fills)
                                    (project-fills snapshot fills)
                                    base-fills)
                                  (merge block-style textStyle)))
                               runs)}))
                    blocks)]
    {:type "root"
     :vertical-align (:verticalAlign base-style)
     :children [{:type "paragraph-set"
                 :children paragraphs}]}))

(defn- parent-index
  [nodes]
  (reduce-kv
   (fn [index _ {:keys [children id]}]
     (reduce #(assoc %1 %2 id) index children))
   {}
   nodes))

(defn- presentation-root-ids
  [{:keys [rootId rootIds]}]
  (if (some? rootIds)
    rootIds
    [rootId]))

(def ^:private quarter-turns
  {0 [1 0] 90 [0 1] 180 [-1 0] 270 [0 -1]})

(defn- translation-only?
  [matrix]
  (and (== 1 (:a matrix)) (== 0 (:b matrix))
       (== 0 (:c matrix)) (== 1 (:d matrix))))

(defn- node-matrix
  "The canonical node transform, the matrix render.mjs `nodeTransform`
  builds: move to x/y, then rotate and flip about the node center."
  [{:keys [x y width height rotation flipX flipY]}]
  (let [x        (or x 0)
        y        (or y 0)
        rotation (if (number? rotation) (mod rotation 360) 0)
        sx       (if (true? flipX) -1 1)
        sy       (if (true? flipY) -1 1)]
    (if (and (zero? rotation) (= 1 sx sy))
      (gmt/translate-matrix x y)
      (let [hw        (/ (or width 0) 2)
            hh        (/ (or height 0) 2)
            angle     (mth/radians rotation)
            [cos sin] (or (get quarter-turns rotation)
                          [(mth/cos angle) (mth/sin angle)])]
        (gmt/multiply (gmt/translate-matrix (+ x hw) (+ y hh))
                      (gmt/matrix (* cos sx) (* sin sx)
                                  (* (- sin) sy) (* cos sy)
                                  0 0)
                      (gmt/translate-matrix (- hw) (- hh)))))))

(defn- child-geometry
  "Compose a node into its parent's absolute geometry. A mirrored parent turns
  its children the other way: diag(-1, 1)·R(t) = R(-t)·diag(-1, 1)."
  [{:keys [matrix rotation flip-x flip-y]} node]
  (let [own (if (number? (:rotation node)) (:rotation node) 0)
        hw  (/ (or (:width node) 0) 2)
        hh  (/ (or (:height node) 0) 2)]
    {:matrix   (gmt/multiply matrix (node-matrix node))
     ;; A node turns about its own center, so map that center through the
     ;; parent only: exact whenever the parent is.
     :center   (gpt/transform (gpt/point (+ (or (:x node) 0) hw)
                                         (+ (or (:y node) 0) hh))
                              matrix)
     :rotation (mod (if (not= flip-x flip-y)
                      (- rotation own)
                      (+ rotation own))
                    360)
     :flip-x   (not= flip-x (true? (:flipX node)))
     :flip-y   (not= flip-y (true? (:flipY node)))}))

(defn- origin-geometry
  [offset-x offset-y]
  {:matrix   (gmt/translate-matrix offset-x offset-y)
   :rotation 0
   :flip-x   false
   :flip-y   false})

(defn- absolute-origins
  "SmallPen node geometry is relative to the parent node: x/y, rotation and
  flips apply inside the parent's full transform (render.mjs composes the
  same matrices). Penpot shapes are absolute within the page. Compose every
  ancestor transform so both models agree: each entry holds the absolute
  :matrix plus the page-level :rotation and :flip-x/:flip-y Penpot stores.
  offsets shifts the whole tree, used to lay variants out side by side."
  ([nodes root-ids] (absolute-origins nodes root-ids 0 0))
  ([nodes root-ids offset-x offset-y]
   (letfn [(walk [origins node-id parent]
             (if-let [node (lookup nodes node-id)]
               (let [geometry (child-geometry parent node)]
                 (reduce (fn [acc child-id] (walk acc child-id geometry))
                         (assoc origins node-id geometry)
                         (:children node)))
               origins))]
     (reduce (fn [origins root-id]
               (walk origins root-id (origin-geometry offset-x offset-y)))
             {}
             root-ids))))

(defn- geometry-origin
  "Penpot x/y of a width x height box placed by geometry: the selrect corner
  around the transformed center."
  [{:keys [matrix center]} width height]
  (if (translation-only? matrix)
    [(:e matrix) (:f matrix)]
    (let [center (or center
                     (gpt/transform (gpt/point (/ width 2) (/ height 2))
                                    matrix))]
      [(- (:x center) (/ width 2)) (- (:y center) (/ height 2))])))

(defn- node-runtime-id
  "Resolve one node's runtime UUID. node-path is the runtime lookup prefix:
  [:nodes screen-id presentation-id] for Screen nodes, or
  [:componentNodes component-id variant-id] for Component Set variant nodes."
  [snapshot node-path node-id]
  (apply runtime-id snapshot (conj (vec node-path) node-id)))

(def ^:private frame-node-types
  "Node types Penpot draws as boards: a component main and a copy too."
  #{"FRAME" "COMPONENT" "INSTANCE"})

(defn- nearest-frame-id
  [snapshot node-path nodes parents node-id]
  (loop [parent-id (get parents node-id)]
    (if parent-id
      (let [parent (lookup nodes parent-id)]
        (if (contains? frame-node-types (:type parent))
          (node-runtime-id snapshot node-path parent-id)
          (recur (get parents parent-id))))
      uuid/zero)))

(defn- screen-plugin-data
  [screen-id presentation-id node-id]
  {:smallpen
   {"node-id" node-id
    "presentation-id" presentation-id
    "screen-id" screen-id}})

(defn- root-origin
  "Penpot x/y of a projected subtree root, the point shift-origins moves."
  [origins nodes root-id]
  (let [root (lookup nodes root-id)]
    (if-let [geometry (lookup origins root-id)]
      (geometry-origin geometry (or (:width root) 0) (or (:height root) 0))
      [0 0])))

(defn- shift-origins
  "Translate every accumulated origin by (delta-x delta-y). Used to place a
  projected subtree at an exact board position: shapes must be BUILT at their
  final x/y (setup-shape derives selrect/points from them), never moved
  afterwards (DSE-R08)."
  [origins delta-x delta-y]
  (let [delta (gmt/translate-matrix delta-x delta-y)]
    (into {}
          (map (fn [[node-id geometry]]
                 [node-id (-> geometry
                              (update :matrix #(gmt/multiply delta %))
                              (update :center gpt/transform delta))]))
          origins)))

(defn- with-layout-offset
  "Wrap a plugin-data builder so every shape of a tree drawn away from its
  source placement records that shift as \"layout-offset\" (\"dx dy\").
  Penpot reports the copy's page-absolute geometry; the commit sends the
  shift along so the adapter maps an edit back to the source node."
  [plugin-data-fn delta-x delta-y]
  (fn [node-id]
    (assoc-in (plugin-data-fn node-id)
              [:smallpen "layout-offset"]
              (str delta-x " " delta-y))))

(defn- subtree-nodes
  "The nodes reachable from root-id, keyed by id."
  [nodes root-id]
  (letfn [(walk [acc node-id]
            (if-let [node (lookup nodes node-id)]
              (reduce walk (assoc acc node-id node) (:children node))
              acc))]
    (walk {} root-id)))

(defn- screen-presentation
  "Resolve one screen presentation from the snapshot entries."
  [snapshot screen-id presentation-id]
  (->> (get-in snapshot [:manifest :entries :screens])
       (map #(lookup (:entries snapshot) %))
       (some (fn [screen]
               (when (= (:id screen) screen-id)
                 (some (fn [presentation]
                         (when (= (:id presentation) presentation-id)
                           presentation))
                       (:presentations screen)))))))

(defn- component-plugin-data
  [component-id variant-id node-id]
  {:smallpen
   {"component-id" component-id
    "node-id" node-id
    "variant-id" variant-id}})

(defn- component-entries
  [snapshot]
  (->> (get-in snapshot [:manifest :entries :components])
       (map #(lookup (:entries snapshot) %))))

(defn- component-index
  "Components stored in Penpot's located main-instance form. A Component Set
  file carries no top-level :id and is indexed by component-set-index instead."
  [snapshot]
  (->> (component-entries snapshot)
       (remove #(sequential? (:componentSets %)))
       (filter :id)
       (map (juxt :id identity))
       (into {})))

(defn- component-set-index
  "Component Sets, the canonical SmallPen form: one record per set, each holding
  its axes and the variants that own the actual node trees."
  [snapshot]
  (->> (component-entries snapshot)
       (mapcat :componentSets)
       (filter :id)
       (map (juxt :id identity))
       (into {})))

(defn- component-reference
  [snapshot component-id component-variant-id]
  (let [{:keys [asset-id file-id owner]}
        (referenced-asset snapshot component-id)]
    {:component-id
     (if component-variant-id
       (runtime-id owner :variants asset-id component-variant-id)
       (runtime-id owner :components asset-id))
     :file-id file-id
     :owner owner
     :stable-id asset-id
     :variant-id component-variant-id}))

(defn- component-source-runtime-id
  [snapshot components component-id component-variant-id source-node-id]
  (let [{:keys [owner stable-id variant-id]}
        (component-reference snapshot component-id component-variant-id)]
    (if variant-id
      (runtime-id owner :componentNodes stable-id variant-id source-node-id)
      (let [owner-components (if (identical? owner snapshot)
                               components
                               (component-index owner))
            {:keys [presentationId screenId]}
            (lookup owner-components stable-id)]
        (runtime-id owner :nodes screenId presentationId source-node-id)))))

(defn- token-library
  [snapshot]
  (->> (get-in snapshot [:manifest :entries :tokens])
       (map #(lookup (:entries snapshot) %))
       (some #(when (and (vector? (:sets %))
                         (vector? (:themes %)))
                %))))

(def ^:private dtcg-value-key (keyword "$value"))
(def ^:private dtcg-type-key (keyword "$type"))
(def ^:private dtcg-description-key (keyword "$description"))
(def ^:private dtcg-extensions-key (keyword "$extensions"))

(defn- dtcg-token-definitions
  ([value]
   (dtcg-token-definitions value [] nil))
  ([value segments inherited-type]
   (let [declared-type (or (get value dtcg-type-key) inherited-type)]
     (->> value
          (mapcat
           (fn [[key child]]
             (let [segment (name key)]
               (if (or (str/starts-with? segment "$")
                       (not (map? child)))
                 []
                 (let [path     (conj segments segment)
                       smallpen (get-in child [dtcg-extensions-key :smallpen])]
                   (if (contains? child dtcg-value-key)
                     [{:description (get child dtcg-description-key)
                       :id (:id smallpen)
                       :name (str/join "." path)
                       :type (or (get child dtcg-type-key) declared-type)
                       :value (get child dtcg-value-key)}]
                     (dtcg-token-definitions child path declared-type)))))))
          (filter #(and (string? (:id %))
                        (string? (:type %))))
          (vec)))))

(defn- snapshot-dtcg-token-definitions
  [snapshot]
  (->> (get-in snapshot [:manifest :entries :tokens])
       (keep #(lookup (:entries snapshot) %))
       (remove #(and (vector? (:sets %))
                     (vector? (:themes %))))
       (mapcat dtcg-token-definitions)
       (vec)))

(defn- asset-library
  [snapshot]
  (some->> (first (get-in snapshot [:manifest :entries :assets]))
           (lookup (:entries snapshot))))

(defn- project-color-library
  [snapshot colors]
  (into {}
        (map (fn [{:keys [id name paint path]}]
               (let [runtime-color-id (runtime-id snapshot :colors id)
                     {:keys [color opacity type]} paint]
                 [runtime-color-id
                  (cond-> {:id runtime-color-id
                           :name name
                           :path path}
                    (number? opacity) (assoc :opacity opacity)
                    (= type "solid") (assoc :color color)
                    (= type "image")
                    (assoc :image (project-media-reference snapshot
                                                           (:mediaRef paint)))
                    (or (= type "linear-gradient")
                        (= type "radial-gradient"))
                    (assoc :gradient (project-gradient paint)))])))
        colors))

(defn- project-media-library
  [snapshot media]
  (let [file-id (-> snapshot :runtime :file uuid/parse)]
    (into {}
          (map (fn [{:keys [height id mimeType name path width]}]
                 (let [runtime-media-id (runtime-id snapshot :media id)]
                   [runtime-media-id
                    {:file-id file-id
                     :height height
                     :id runtime-media-id
                     :is-local true
                     :media-id (runtime-id snapshot :mediaStorage id)
                     :mtype mimeType
                     :name name
                     :path path
                     :width width}])))
          media)))

(defn- project-typography-library
  [snapshot typographies]
  (into {}
        (map (fn [{:keys [id name path style]}]
               (let [{:keys [fontFamily fontId fontSize fontStyle fontVariantId
                             fontWeight letterSpacing lineHeight
                             textTransform]} style
                     runtime-typography-id (runtime-id snapshot
                                                       :typographies
                                                       id)
                     projected-font-id (project-font-id snapshot
                                                        fontId
                                                        fontFamily)]
                 [runtime-typography-id
                  {:id runtime-typography-id
                   :name name
                   :path path
                   :font-family fontFamily
                   :font-id projected-font-id
                   :font-size (str fontSize)
                   :font-style fontStyle
                   :font-variant-id (project-font-variant-id projected-font-id
                                                             fontVariantId
                                                             fontWeight
                                                             fontStyle)
                   :font-weight (str fontWeight)
                   :letter-spacing (str letterSpacing)
                   :line-height (str lineHeight)
                   :text-transform textTransform}])))
        typographies))

(defn- penpot-token-value
  "Penpot holds a shadow Token as a vector of shadows with string lengths;
  the Package holds one DTCG shadow object or a list of them. Without this
  Penpot cannot resolve the Token, and applying it does nothing."
  [type value]
  (if (and (= "shadow" type)
           (or (map? value) (sequential? value)))
    (mapv (fn [shadow]
            (let [field #(some (fn [key] (lookup shadow key)) %)]
              {:offset-x (str (or (field ["offsetX" "offset-x" "x"]) 0))
               :offset-y (str (or (field ["offsetY" "offset-y" "y"]) 0))
               :blur (str (or (field ["blur"]) 0))
               :spread (str (or (field ["spread"]) 0))
               :color (str (field ["color"]))
               :inset (true? (field ["inset"]))}))
          (if (map? value) [value] value))
    value))

(defn- project-token-parts
  "One Penpot token library from the Form A libraries of `parts`, each
  {:owner snapshot :library library :active-theme-ids ids}: their sets and
  themes in part order (a later set overrides an earlier one by name, as
  Penpot resolves it). A part without an active theme contributes its
  activeSetIds through Penpot's hidden theme."
  [parts]
  (let [token-sets
        (into []
              (mapcat
               (fn [{:keys [owner library]}]
                 (map (fn [{:keys [description id name tokens]}]
                        (ctob/make-token-set
                         {:description description
                          :id (runtime-id owner :tokenSets id)
                          :name name
                          :tokens
                          ;; Canonical token order survives: a plain map literal
                          ;; would reorder sets with more than eight tokens.
                          (into (d/ordered-map)
                                (map (fn [{:keys [description id name type value]}]
                                       [name
                                        (ctob/make-token
                                         {:description description
                                          :id (runtime-id owner :tokens id)
                                          :name name
                                          :type (keyword type)
                                          :value (penpot-token-value type value)})]))
                                tokens)}))
                      (:sets library))))
              parts)
        _ (when (not= (count token-sets)
                      (count (into #{} (map ctob/get-name) token-sets)))
            (throw (ex-info "SmallPen token set names collide between the Foundation and the Product"
                            {:type :validation
                             :code :smallpen-token-set-name-collision
                             :sets (mapv ctob/get-name token-sets)})))
        part-themes
        (mapv (fn [{:keys [owner library]}]
                (let [set-names (into {} (map (juxt :id :name)) (:sets library))]
                  (mapv (fn [{:keys [description externalId group id isSource name setIds]}]
                          [id
                           (ctob/make-token-theme
                            {:description description
                             :external-id externalId
                             :group group
                             :id (runtime-id owner :tokenThemes id)
                             :is-source isSource
                             :name name
                             :sets (set (map #(lookup set-names %) setIds))})])
                        (:themes library))))
              parts)
        active-theme-paths
        (into #{}
              cat
              (map (fn [{:keys [active-theme-ids]} themes]
                     (let [by-id (into {} themes)]
                       (keep #(some-> (lookup by-id %) ctob/get-theme-path)
                             active-theme-ids)))
                   parts
                   part-themes))
        set-names-of (fn [{:keys [library]}]
                       (let [set-names (into {} (map (juxt :id :name)) (:sets library))]
                         (keep #(lookup set-names %) (:activeSetIds library))))
        unthemed-sets (into #{}
                            (comp (remove #(seq (:active-theme-ids %)))
                                  (mapcat set-names-of))
                            parts)
        result (reduce ctob/add-set (ctob/make-tokens-lib) token-sets)
        result (ctob/update-theme
                result
                uuid/zero
                (fn [_]
                  (ctob/make-hidden-theme
                   :sets (if (seq unthemed-sets)
                           unthemed-sets
                           (into #{} (mapcat set-names-of) parts)))))
        result (reduce ctob/add-theme result (into [] (comp cat (map second)) part-themes))]
    (spts/set-active-themes result
                            (cond-> active-theme-paths
                              (or (empty? active-theme-paths) (seq unthemed-sets))
                              (conj ctob/hidden-theme-path)))))

(defn- project-token-library
  [snapshot library]
  (project-token-parts [{:owner snapshot
                         :library library
                         :active-theme-ids (:activeThemeIds library)}]))

(defn- foundation-token-data
  "What a Product's token manager must not edit (edit_policy.cljs): the
  runtime ids of its Foundation's sets, themes and tokens and the set
  names, as JSON plugin-data."
  [{:keys [owner library]}]
  (js/JSON.stringify
   (clj->js
    {:ids (map str
               (concat (map #(runtime-id owner :tokenSets (:id %)) (:sets library))
                       (map #(runtime-id owner :tokenThemes (:id %)) (:themes library))
                       (for [token-set (:sets library)
                             token (:tokens token-set)]
                         (runtime-id owner :tokens (:id token)))))
     :sets (map :name (:sets library))})))

(defn- foundation-token-part
  "The Form A library of the Foundation a Product depends on, with the
  Product's selection of its themes: the Background's `tokenThemes` rows
  (core listTokenThemes), else the dependency's activeThemeIds, else the
  Foundation's own (docs/TOKEN-THEMES.md 3.2)."
  [snapshot]
  (some (fn [{:keys [packageId] :as dependency}]
          (when-let [owner (some #(when (= packageId (get-in % [:manifest :packageId])) %)
                                 (:libraries snapshot))]
            (when-let [library (token-library owner)]
              (let [rows (filter #(= packageId (:packageId %)) (:tokenThemes snapshot))]
                {:owner owner
                 :library library
                 :active-theme-ids
                 (cond
                   (seq rows)
                   (into [] (comp (filter :active) (map :id)) rows)

                   (contains? dependency :activeThemeIds)
                   (:activeThemeIds dependency)

                   :else
                   (:activeThemeIds library))}))))
        (get-in snapshot [:manifest :dependencies])))

(defn- unused-token-set-name
  [tokens-lib]
  (loop [candidate "Library Tokens"
         suffix 2]
    (if (ctob/get-set-by-name tokens-lib candidate)
      (recur (str "Library Tokens " suffix) (inc suffix))
      candidate)))

(defn- add-dtcg-token-set
  [snapshot tokens-lib definitions]
  (if (or (empty? definitions)
          (not (string? (get-in snapshot [:runtime :dtcgTokenSet]))))
    tokens-lib
    (let [set-name  (unused-token-set-name tokens-lib)
          token-set (ctob/make-token-set
                     {:id (-> snapshot :runtime :dtcgTokenSet uuid/parse)
                      :name set-name
                      :tokens
                      (into (d/ordered-map)
                            (map (fn [{:keys [description id name type value]}]
                                   [name
                                    (ctob/make-token
                                     {:description description
                                      :id (runtime-id snapshot :tokens id)
                                      :name name
                                      :type (keyword type)
                                      :value (penpot-token-value type value)})]))
                            definitions)})]
      (-> tokens-lib
          (ctob/add-set token-set)
          (ctob/update-theme uuid/zero #(update % :sets conj set-name))
          (spts/set-active-themes
           (conj (spts/get-active-theme-paths tokens-lib)
                 ctob/hidden-theme-path))))))

(defn- default-token-library
  []
  (let [token-set (ctob/make-token-set :name "Theme/Default")
        token-theme (ctob/make-token-theme
                     :group "Theme"
                     :name "Default"
                     :sets #{"Theme/Default"})]
    (-> (ctob/make-tokens-lib)
        (ctob/add-set token-set)
        (ctob/add-theme token-theme)
        (spts/activate-theme (ctob/get-id token-theme)))))

(defn- linear-part
  [matrix]
  (gmt/matrix (:a matrix) (:b matrix) (:c matrix) (:d matrix) 0 0))

(defn- project-path-geometry
  "Penpot path content is page-absolute and already turned, so map the local
  pathData through the node's absolute matrix. A turned path keeps its local
  bounds as selrect around the turned center, like Penpot's own transforms."
  [path-data matrix]
  (let [content (path/from-string path-data)]
    (if (translation-only? matrix)
      {:content (path/move-content content
                                   (gpt/point (:e matrix) (:f matrix)))}
      (let [bounds (path/calc-selrect content)
            center (gpt/transform (grc/rect->center bounds) matrix)]
        {:content (path/transform-content content matrix)
         :selrect (grc/center->rect center (:width bounds) (:height bounds))
         :points  (mapv #(gpt/transform % matrix) (grc/rect->points bounds))}))))

(defn- project-prototype-interaction
  [interaction]
  (cond-> interaction
    (some? (:event-type interaction))
    (update :event-type keyword)

    (some? (:action-type interaction))
    (update :action-type keyword)

    (some? (:overlay-pos-type interaction))
    (update :overlay-pos-type keyword)

    (some? (:destination interaction))
    (update :destination uuid/parse)

    (some? (:position-relative-to interaction))
    (update :position-relative-to uuid/parse)

    (some? (:overlay-position interaction))
    (update :overlay-position
            (fn [{:keys [x y]}]
              (gpt/point x y)))

    (some? (:animation interaction))
    (update :animation
            (fn [animation]
              (cond-> animation
                (some? (:animation-type animation))
                (update :animation-type keyword)

                (some? (:easing animation))
                (update :easing keyword)

                (some? (:direction animation))
                (update :direction keyword)

                (some? (:way animation))
                (update :way keyword))))))

(defn- project-prototype-flows
  [snapshot screen-id presentation-id flows]
  (into {}
        (map (fn [{:keys [id name startingNodeId]}]
               (let [flow-id (uuid/parse id)]
                 [flow-id
                  {:id flow-id
                   :name name
                   :starting-frame (runtime-id snapshot
                                               :nodes
                                               screen-id
                                               presentation-id
                                               startingNodeId)}])))
        flows))

(declare css-color->attrs)

(defn- invalid-shadow
  [value]
  (throw (ex-info "unsupported SmallPen shadow"
                  {:type :validation
                   :code :unsupported-smallpen-shadow
                   :shadow value})))

(defn- shadow-length
  "A shadow length is a number or a px string (\"4\", \"4px\")."
  [record value]
  (cond
    (nil? value) 0
    (number? value) value

    (and (string? value) (re-matches #"-?\d+(\.\d+)?(px)?" (str/trim value)))
    (js/parseFloat value)

    :else (invalid-shadow record)))

(defn- dtcg-shadow
  "A DTCG shadow object -> a native shadow record carrying the full common
  Shadow schema (id, style, hidden, color attrs), so effects panel edits
  re-validated with check-shadow succeed and rgba/hex colors keep their
  alpha. Older Packages store the offsets as x/y."
  [value]
  (let [field #(some (fn [key] (lookup value key)) %)
        color (css-color->attrs (field ["color"]))]
    (when-not color
      (throw (ex-info "unsupported SmallPen shadow color"
                      {:type :validation
                       :code :unsupported-smallpen-shadow-color
                       :color (field ["color"])})))
    {:id nil
     :style (if (true? (field ["inset"])) :inner-shadow :drop-shadow)
     :hidden false
     :blur (shadow-length value (field ["blur"]))
     :offset-x (shadow-length value (field ["offsetX" "offset-x" "x"]))
     :offset-y (shadow-length value (field ["offsetY" "offset-y" "y"]))
     :spread (shadow-length value (field ["spread"]))
     :color color}))

(defn- native-shadow
  "A shadow edited in Penpot is stored as its native record, with the
  style as a string, the id as a uuid string and color attrs as a map."
  [value]
  (let [style (keyword (or (lookup value "style") "drop-shadow"))
        color (lookup value "color")]
    (when-not (and (contains? #{:drop-shadow :inner-shadow} style)
                   (map? color))
      (invalid-shadow value))
    {:id (some-> (lookup value "id") str uuid/parse*)
     :style style
     :hidden (true? (lookup value "hidden"))
     :blur (shadow-length value (lookup value "blur"))
     :offset-x (shadow-length value (lookup value "offset-x"))
     :offset-y (shadow-length value (lookup value "offset-y"))
     :spread (shadow-length value (lookup value "spread"))
     :color (cond-> {:color (lookup color "color")
                     :opacity (or (lookup color "opacity") 1)}
              (some? (lookup color "ref-id"))
              (assoc :ref-id (uuid/parse* (str (lookup color "ref-id"))))

              (some? (lookup color "ref-file"))
              (assoc :ref-file (uuid/parse* (str (lookup color "ref-file")))))}))

(defn- project-shadow
  "A Package shadow (one record or a list) -> Penpot's native shadow
  vector. Records are DTCG objects (what a bound shadow Token resolves to)
  or native records saved from Penpot; anything else fails explicitly
  rather than reaching the shape unconverted."
  [value]
  (let [records (if (map? value) [value] value)]
    (when-not (and (sequential? records) (every? map? records))
      (invalid-shadow value))
    (mapv (fn [record]
            (if (or (some? (lookup record "style"))
                    (map? (lookup record "color")))
              (native-shadow record)
              (dtcg-shadow record)))
          records)))

(defn- project-node
  [snapshot components node-path plugin-data-fn origins nodes parents root-ids node]
  (let [{:keys [appliedTokens penpotAppliedTokens backgroundBlur blend-mode blur children componentId
                componentVariantId content
                cornerRadius exports fills fixed-scroll growType
                grids height hide-fill-on-export hide-in-viewer id interactions
                layout layout-align-content layout-align-items
                layout-flex-dir layout-gap layout-gap-type layout-item-absolute
                layout-item-align-self layout-item-h-sizing layout-item-margin
                layout-item-margin-type layout-item-max-h layout-item-max-w
                layout-item-min-h layout-item-min-w layout-item-v-sizing
                layout-item-z-index layout-justify-content layout-padding
                layout-padding-type layout-wrap-type locked masked-group mediaRef name opacity
                pathData proportionLock shadow sourceNodeId
                show-content strokes text textBlocks textStyle tokenBindings touched type
                visible width constraints-h constraints-v]} node
        shape-id    (node-runtime-id snapshot node-path id)
        component-context
        (or (when componentId
              {:component-id componentId
               :variant-id componentVariantId})
            (loop [ancestor-id (get parents id)]
              (when ancestor-id
                (let [ancestor (lookup nodes ancestor-id)]
                  (if (= "INSTANCE" (:type ancestor))
                    {:component-id (:componentId ancestor)
                     :variant-id (:componentVariantId ancestor)}
                    (recur (get parents ancestor-id)))))))
        component-id (:component-id component-context)
        component-variant-id (:variant-id component-context)
        component-target (when component-id
                           (component-reference snapshot
                                                component-id
                                                component-variant-id))
        root?       (contains? root-ids id)
        parent-id   (if root?
                      uuid/zero
                      (node-runtime-id snapshot node-path (get parents id)))
        frame-id    (if root?
                      uuid/zero
                      (nearest-frame-id snapshot node-path nodes parents id))
        corner-radii (when (some? cornerRadius)
                       (project-corner-radius cornerRadius))
        geometry    (or (lookup origins id)
                        (child-geometry (origin-geometry 0 0) node))
        matrix      (:matrix geometry)
        turned?     (not (translation-only? matrix))
        transform   (when turned? (linear-part matrix))
        [abs-x abs-y] (geometry-origin geometry (or width 0) (or height 0))
        ;; The Background computes the applied Tokens from the bindings with
        ;; core's one table (token-attributes.mjs); the App translates none.
        applied-tokens (into {}
                             (map (fn [[attribute token-name]]
                                    [(keyword attribute) token-name]))
                             (or penpotAppliedTokens appliedTokens))]
    (cts/setup-shape
     (cond->
      {:id shape-id
       :name name
       :type (node-type type)
       :x abs-x
       :y abs-y
       :width width
       :height height
       :interactions (mapv project-prototype-interaction interactions)
       :parent-id parent-id
       :frame-id frame-id
       :plugin-data (plugin-data-fn id)}
       (seq children)
       (assoc :shapes (mapv #(node-runtime-id snapshot node-path %) children))

       (and (not= type "TEXT") (seq fills))
       (assoc :fills (project-fills snapshot fills))

       ;; No fills means no paint, as the Package renderer draws it; Penpot
       ;; would otherwise give boards a white and shapes a grey default.
       ;; Only a screen's root board keeps Penpot's (and the renderer's)
       ;; white; Instances and variant or Component roots never do.
       (and (empty? fills)
            (not (and root? (= type "FRAME") (= :nodes (first node-path))))
            (contains? #{"COMPONENT" "ELLIPSE" "FRAME" "INSTANCE" "RECTANGLE"} type))
       (assoc :fills [])

       (= type "TEXT")
       (assoc :content (project-text-content snapshot
                                             text
                                             fills
                                             textStyle
                                             textBlocks)
              :grow-type (keyword (or growType "fixed")))

       (= type "IMAGE")
       (assoc :metadata (dissoc (project-media-reference snapshot mediaRef)
                                :keep-aspect-ratio
                                :name))

       (seq strokes)
       (assoc :strokes (project-strokes snapshot strokes))

       (some? backgroundBlur)
       (assoc :background-blur backgroundBlur)

       (some? blur)
       (assoc :blur blur)

       (some? shadow)
       (assoc :shadow (project-shadow shadow))

       (some? blend-mode)
       (assoc :blend-mode (keyword blend-mode))

       (some? grids)
       (assoc :grids grids)

       (some? hide-fill-on-export)
       (assoc :hide-fill-on-export hide-fill-on-export)

       (some? hide-in-viewer)
       (assoc :hide-in-viewer hide-in-viewer)

       ;; Like a board drawn inside a board in Penpot, a nested board is
       ;; not a View mode screen unless the Package says it is.
       (and (nil? hide-in-viewer) (not root?) (= :frame (node-type type)))
       (assoc :hide-in-viewer true)

       (some? masked-group)
       (assoc :masked-group masked-group)

       (some? show-content)
       (assoc :show-content show-content)

       (some? layout)
       (assoc :layout (keyword layout))

       (some? layout-flex-dir)
       (assoc :layout-flex-dir (keyword layout-flex-dir))

       (some? layout-gap-type)
       (assoc :layout-gap-type (keyword layout-gap-type))

       (some? layout-gap)
       (assoc :layout-gap layout-gap)

       (some? layout-align-items)
       (assoc :layout-align-items (keyword layout-align-items))

       (some? layout-justify-content)
       (assoc :layout-justify-content (keyword layout-justify-content))

       (some? layout-align-content)
       (assoc :layout-align-content (keyword layout-align-content))

       (some? layout-wrap-type)
       (assoc :layout-wrap-type (keyword layout-wrap-type))

       (some? layout-padding-type)
       (assoc :layout-padding-type (keyword layout-padding-type))

       (some? layout-padding)
       (assoc :layout-padding layout-padding)

       (some? layout-item-margin)
       (assoc :layout-item-margin layout-item-margin)

       (some? layout-item-margin-type)
       (assoc :layout-item-margin-type (keyword layout-item-margin-type))

       (some? layout-item-h-sizing)
       (assoc :layout-item-h-sizing (keyword layout-item-h-sizing))

       (some? layout-item-v-sizing)
       (assoc :layout-item-v-sizing (keyword layout-item-v-sizing))

       (some? layout-item-max-h)
       (assoc :layout-item-max-h layout-item-max-h)

       (some? layout-item-min-h)
       (assoc :layout-item-min-h layout-item-min-h)

       (some? layout-item-max-w)
       (assoc :layout-item-max-w layout-item-max-w)

       (some? layout-item-min-w)
       (assoc :layout-item-min-w layout-item-min-w)

       (some? layout-item-align-self)
       (assoc :layout-item-align-self (keyword layout-item-align-self))

       (some? layout-item-absolute)
       (assoc :layout-item-absolute layout-item-absolute)

       (some? layout-item-z-index)
       (assoc :layout-item-z-index layout-item-z-index)

       (some? constraints-h)
       (assoc :constraints-h (if (string? constraints-h)
                               (keyword constraints-h)
                               constraints-h))

       (some? constraints-v)
       (assoc :constraints-v (if (string? constraints-v)
                               (keyword constraints-v)
                               constraints-v))

       (some? fixed-scroll)
       (assoc :fixed-scroll fixed-scroll)

       (some? exports)
       (assoc :exports exports)

       ;; A turned or mirrored node carries the composed linear transform;
       ;; setup-shape derives its points from selrect and transform.
       turned?
       (assoc :transform transform
              :transform-inverse (gmt/inverse transform))

       (not (zero? (:rotation geometry)))
       (assoc :rotation (:rotation geometry))

       (:flip-x geometry)
       (assoc :flip-x true)

       (:flip-y geometry)
       (assoc :flip-y true)

       ;; Canonical pathData is local to the node box, but Penpot path
       ;; content is page-absolute (setup-path derives the selrect from it
       ;; unless given). A stored `points` field is derived Penpot state
       ;; from older packages and never projected: the box corners always
       ;; follow the composed transform.
       (and (= type "PATH") (or (some? pathData) (some? content)))
       (merge (project-path-geometry (or pathData content) matrix))

       (and (= type "PATH") (some? pathData))
       (assoc :path-data pathData)

       (number? opacity)
       (assoc :opacity opacity)

       (some? corner-radii)
       (assoc :r1 (nth corner-radii 0)
              :r2 (nth corner-radii 1)
              :r3 (nth corner-radii 2)
              :r4 (nth corner-radii 3))

       (= false visible)
       (assoc :hidden true)

       (true? locked)
       (assoc :blocked true)

       (true? proportionLock)
       (assoc :proportion-lock true)

       (and (true? proportionLock) (not (zero? height)))
       (assoc :proportion (/ width height))

       (or (some? appliedTokens) (some? penpotAppliedTokens) (seq applied-tokens))
       (assoc :applied-tokens applied-tokens)

       ;; A Component Set variant root is also typed COMPONENT but carries no
       ;; componentId; its caller supplies the component wiring instead.
       (and (= type "COMPONENT") (some? component-id))
       (assoc :component-id (:component-id component-target)
              :component-file (:file-id component-target)
              :component-root true
              :main-instance true)

       (= type "INSTANCE")
       (assoc :component-id (:component-id component-target)
              :component-file (:file-id component-target)
              :component-root true
              :shape-ref (component-source-runtime-id snapshot
                                                      components
                                                      component-id
                                                      component-variant-id
                                                      sourceNodeId))

       (and (not= type "INSTANCE") (some? sourceNodeId))
       (assoc :shape-ref (component-source-runtime-id snapshot
                                                      components
                                                      component-id
                                                      component-variant-id
                                                      sourceNodeId))

       (some? touched)
       (assoc :touched (set (map keyword touched)))))))

(defn- show-interaction-destinations
  "A nested board an interaction navigates to stays a View mode screen, as
  Penpot shows a hidden board once it becomes a destination, unless the
  Package hides it explicitly."
  [nodes shapes]
  (reduce (fn [shapes id]
            (let [node-id (get-in shapes [id :plugin-data :smallpen "node-id"])]
              (if (and (true? (get-in shapes [id :hide-in-viewer]))
                       (nil? (:hide-in-viewer (lookup nodes node-id))))
                (update shapes id dissoc :hide-in-viewer)
                shapes)))
          shapes
          (into #{} (comp (mapcat :interactions) (keep :destination)) (vals shapes))))

(defn- presentation-page-name
  [screen presentation]
  (if (= (:name screen) (:name presentation))
    (:name screen)
    (str (:name screen) " · " (:name presentation))))

(defn- presentation-parts
  "The shapes, top-level shape ids and prototype flows of one page version,
  for the canvas it is drawn on."
  [snapshot components screen presentation]
  (let [screen-id       (:id screen)
        presentation-id (:id presentation)
        page-id         (runtime-id snapshot :pages screen-id presentation-id)
        nodes           (:nodes presentation)
        root-ids        (presentation-root-ids presentation)
        root-id-set     (set root-ids)
        parents         (parent-index nodes)
        node-path       [:nodes screen-id presentation-id]
        origins         (absolute-origins nodes root-ids)
        shapes          (->> nodes
                             (map (fn [[_ node]]
                                    (project-node snapshot
                                                  components
                                                  node-path
                                                  #(screen-plugin-data screen-id
                                                                       presentation-id
                                                                       %)
                                                  origins
                                                  nodes
                                                  parents
                                                  root-id-set
                                                  node)))
                             (map (juxt :id identity))
                             (into {})
                             (show-interaction-destinations nodes))
        root-shape      (-> (get-in ctp/empty-page-data [:objects uuid/zero])
                            (assoc :shapes
                                   (mapv #(node-runtime-id snapshot node-path %)
                                         root-ids)))
        flows           (project-prototype-flows snapshot
                                                 screen-id
                                                 presentation-id
                                                 (:prototypeFlows presentation))]
    {:shapes shapes
     :root-shape-ids (mapv #(node-runtime-id snapshot node-path %) root-ids)
     :flows flows
     :page-id page-id
     :presentation presentation
     :screen screen}))

(defn- page-settings
  "A one-board canvas carries its page version's background and pixel grid."
  [page presentation]
  (cond-> page
    (some? (:background presentation))
    (assoc :background (:background presentation))

    (some? (:pixel-grid-color presentation))
    (assoc :pixel-grid-color (:pixel-grid-color presentation))

    (some? (:pixel-grid-opacity presentation))
    (assoc :pixel-grid-opacity (:pixel-grid-opacity presentation))))

(defn- project-canvas
  "One canvas as one Penpot page: every page version on it is a board, at the
  place the Background's canvas layout gave it (core canvases.mjs)."
  [snapshot components screens canvas]
  (let [parts      (mapv (fn [{:keys [screenId presentationId]}]
                           (let [screen (get screens screenId)]
                             (presentation-parts snapshot
                                                 components
                                                 screen
                                                 (d/seek #(= presentationId (:id %))
                                                         (:presentations screen)))))
                         (:boards canvas))
        page-id    (or (uuid/parse* (:pageId canvas)) (:page-id (first parts)))
        root-shape (-> (get-in ctp/empty-page-data [:objects uuid/zero])
                       (assoc :shapes (into [] (mapcat :root-shape-ids) parts)))
        flows      (into {} (mapcat :flows) parts)
        single     (when (= 1 (count parts)) (first parts))]
    (-> (ctp/make-empty-page {:id page-id :name (:name canvas)})
        (cond-> single (page-settings (:presentation single)))
        (assoc :objects (into {uuid/zero root-shape} (mapcat :shapes) parts))
        (cond-> (seq flows)
          (assoc :flows flows))
        (assoc :plugin-data
               {:smallpen
                (cond-> {"canvas-id" (:id canvas)}
                  single (assoc "presentation-id" (get-in single [:presentation :id])
                                "screen-id" (get-in single [:screen :id])))}))))

(def ^:private component-grid-gap 80)
(def ^:private component-grid-columns 6)

(defn- variant-properties
  "Penpot variant properties of one variant: one {:name :value} per axis, in
  axis order. Penpot names properties uniquely, so a repeated axis name gets
  Penpot's numbered suffix."
  [component-set variant]
  (let [names (->> (:axes component-set)
                   (mapv (fn [axis] {:name (:name axis) :value ""}))
                   (ctv/update-number-in-repeated-prop-names)
                   (mapv :name))]
    (mapv (fn [axis name]
            {:name name
             :value (str (or (lookup (:selection variant) (:id axis)) ""))})
          (:axes component-set)
          names)))

(defn- component-set-path
  "The Assets folder of a Component Set's components: its category."
  [component-set]
  (cpn/clean-path (str (or (:category component-set) ""))))

(defn- component-set-full-name
  "Penpot names a variant container and its mains after the components'
  folder and name together."
  [component-set]
  (cpn/merge-path-item (component-set-path component-set) (:name component-set)))

(defn- variant-container?
  "A Component Set with axes is a Penpot variant container holding one main
  per variant. One without axes has a single variant: a plain component."
  [component-set]
  (boolean (seq (:axes component-set))))

(defn- grid-offsets
  "Start offset of every track (column or row): the sum of the widest cell
  of each earlier track plus one gap per track."
  ([sizes]
   (grid-offsets sizes component-grid-gap))
  ([sizes gap]
   (vec (reductions (fn [offset size] (+ offset size gap))
                    0
                    (butlast sizes)))))

(defn- variant-placements
  "Lay every variant of every Component Set out on one grid so their main
  instances never overlap: each column is as wide as its widest variant and
  each row as tall as its tallest. One entry per variant, in a stable order."
  [component-sets]
  (let [placements (->> component-sets
                        (sort-by key)
                        (mapcat (fn [[component-id component-set]]
                                  (map (fn [variant]
                                         {:component-id component-id
                                          :component-set component-set
                                          :root (lookup (:nodes variant) (:rootId variant))
                                          :variant variant})
                                       (:variants component-set))))
                        (map-indexed (fn [index placement]
                                       (assoc placement
                                              :column (mod index component-grid-columns)
                                              :row (quot index component-grid-columns))))
                        (vec))
        track-sizes (fn [track size]
                      (->> placements
                           (group-by track)
                           (sort-by key)
                           (mapv (fn [[_ cells]]
                                   (reduce max 0 (map #(or (size (:root %)) 0) cells))))))
        columns    (grid-offsets (track-sizes :column :width))
        rows       (grid-offsets (track-sizes :row :height))]
    (mapv (fn [{:keys [column row] :as placement}]
            (-> placement
                (dissoc :column :row)
                (assoc :offset-x (nth columns column)
                       :offset-y (nth rows row))))
          placements)))

(defn- project-variant-shapes
  "Project one variant's node tree into Penpot shapes. The variant root becomes
  the main instance root of that variant's component. The tree origin lands
  EXACTLY on (offset-x offset-y) regardless of the root node's own x/y, and
  shapes are built at their final coordinates (DSE-R08)."
  [snapshot components {:keys [component-id variant offset-x offset-y]
                        :or {offset-x 0 offset-y 0}}]
  (let [variant-id (:id variant)
        nodes      (:nodes variant)
        root-id    (:rootId variant)
        parents    (parent-index nodes)
        node-path  [:componentNodes component-id variant-id]
        base-origins (absolute-origins nodes [root-id])
        [root-x root-y] (root-origin base-origins nodes root-id)
        origins    (shift-origins base-origins
                                  (- offset-x root-x)
                                  (- offset-y root-y))
        plugin-data (with-layout-offset
                      #(component-plugin-data component-id variant-id %)
                      (- offset-x root-x)
                      (- offset-y root-y))
        cmp-id     (runtime-id snapshot :variants component-id variant-id)
        file-id    (-> snapshot :runtime :file uuid/parse)]
    (->> nodes
         (map (fn [[_ node]]
                (cond-> (project-node snapshot
                                      components
                                      node-path
                                      plugin-data
                                      origins
                                      nodes
                                      parents
                                      #{root-id}
                                      node)
                  (= (:id node) root-id)
                  (assoc :component-id cmp-id
                         :component-file file-id
                         :component-root true
                         :main-instance true))))
         (map (juxt :id identity))
         (into {}))))

(def ^:private variant-container-padding 30)
(def ^:private variant-container-gap 20)
;; With three or more axes the first axis groups the columns while that
;; keeps the table at most this many columns wide.
(def ^:private matrix-max-grouped-columns 12)
(def ^:private matrix-label-size 12)
(def ^:private matrix-header-height 24)
(def ^:private matrix-label-gap 12)
(def ^:private matrix-summary-height 28)
(def ^:private page-content-width 1600)
(def ^:private page-block-gap 80)
(def ^:private page-section-gap 120)

(declare board-text-metrics flow-layout)

(defn- variant-value
  [axis variant]
  (str (or (lookup (:selection variant) (:id axis)) "")))

(defn- value-text
  [value]
  (if (str/blank? value) "—" value))

(defn- axis-values
  "The values of one axis the variants use: in domain order, then the values
  only variants know (one added in Penpot) in variant order."
  [axis variants]
  (let [used    (distinct (map (partial variant-value axis) variants))
        ordered (filter (set used) (distinct (map str (:domain axis))))]
    (vec (concat ordered (remove (set ordered) used)))))

(defn- variant-matrix
  "How the variants of a Component Set read as a table: the last axis gives
  the columns and the combinations of the other axes the rows. With three
  or more axes the first axis also groups the columns, one block per value
  side by side, unless that makes the table wider than
  `matrix-max-grouped-columns`; then it stays the outermost row axis. Rows
  and columns hold only combinations some variant has, in axis value order.
  Each key holds one value per axis of its side; cells are in variant order."
  [{:keys [axes variants]}]
  (let [axes       (vec axes)
        values     (mapv #(axis-values % variants) axes)
        last-index (dec (count axes))
        grouped?   (and (>= (count axes) 3)
                        (<= (* (count (first values)) (count (peek values)))
                            matrix-max-grouped-columns))
        column-ixs (cond
                     (neg? last-index) []
                     grouped?          [0 last-index]
                     :else             [last-index])
        row-ixs    (into [] (remove (set column-ixs)) (range (count axes)))
        key-of     (fn [ixs variant]
                     (mapv #(variant-value (nth axes %) variant) ixs))
        keys-of    (fn [ixs]
                     (->> variants
                          (map (partial key-of ixs))
                          (distinct)
                          (sort-by (fn [key]
                                     (mapv #(d/index-of (nth values %1) %2) ixs key)))
                          (vec)))
        columns    (keys-of column-ixs)
        rows       (keys-of row-ixs)]
    {:column-axes (mapv axes column-ixs)
     :row-axes    (mapv axes row-ixs)
     :columns     columns
     :rows        rows
     :cells       (mapv (fn [variant]
                          {:variant variant
                           :column (d/index-of columns (key-of column-ixs variant))
                           :row (d/index-of rows (key-of row-ixs variant))})
                        variants)}))

(defn- runs
  "[start end) index ranges of consecutive keys sharing their first `depth`
  values: the span of one header label."
  [keys depth]
  (->> (range (count keys))
       (partition-by #(subvec (nth keys %) 0 depth))
       (mapv (fn [indexes] [(first indexes) (inc (last indexes))]))))

(defn- matrix-label
  [text x y & {:keys [size weight muted?]
               :or {size matrix-label-size weight 400 muted? false}}]
  {:text text :x x :y y :size size :weight weight :muted? muted?})

(defn- label-width
  [text size]
  (:width (board-text-metrics text size)))

(defn- set-summary
  [{:keys [axes variants]}]
  (if (seq axes)
    (tr "smallpen.components-page.properties"
        (str/join " × " (map :name axes))
        (count variants))
    (tr "smallpen.components-page.no-properties")))

(defn- component-set-block
  "Layout of one Component Set on the Components page, its top-left corner at
  (x y). A set with axes is a variant container laid out as an axis table
  (`variant-matrix`): inside its padding the property summary, the column
  headers, the row headers on the left and the variant mains in their
  cells. Every column is as wide as its widest variant and every row as
  tall as its tallest, so mains never overlap. Labels are data: the page
  draws them as locked decoration under the container, never inside it. A
  set without axes is its single main. Penpot titles both with the name."
  [component-id component-set x y]
  (let [variants (:variants component-set)
        root     (fn [variant] (lookup (:nodes variant) (:rootId variant)))
        size     (fn [variant key] (or (key (root variant)) 0))
        place    (fn [variant offset-x offset-y]
                   {:component-id component-id
                    :component-set component-set
                    :variant variant
                    :offset-x offset-x
                    :offset-y offset-y})]
    (if-not (variant-container? component-set)
      (let [variant (first variants)]
        {:component-id component-id
         :component-set component-set
         :labels []
         :placements (if variant [(place variant x y)] [])
         :width (if variant (size variant :width) 0)
         :height (if variant (size variant :height) 0)})
      (let [{:keys [column-axes row-axes columns rows cells]}
            (variant-matrix component-set)
            gap          variant-container-gap
            padding      variant-container-padding
            grouped?     (= 2 (count column-axes))
            ;; Variants with the same values (an edit in progress) share a
            ;; cell and stack in it.
            members      (group-by (juxt :column :row) cells)
            stack-height (fn [cells]
                           (+ (reduce + (map #(size (:variant %) :height) cells))
                              (* gap (dec (count cells)))))
            slot-y       (into {}
                               (mapcat (fn [[_ cells]]
                                         (map (fn [cell offset]
                                                [(:id (:variant cell)) offset])
                                              cells
                                              (reductions + 0 (map #(+ gap (size (:variant %) :height))
                                                                   cells)))))
                               members)
            group-label  (fn [key]
                           (str (:name (first column-axes)) ": " (value-text (first key))))
            widths       (mapv (fn [column]
                                 (reduce max
                                         (label-width (value-text (peek (nth columns column)))
                                                      matrix-label-size)
                                         (for [[[c _] cells] members
                                               :when (= c column)
                                               cell cells]
                                           (size (:variant cell) :width))))
                               (range (count columns)))
            ;; A group label spans its columns: widen the last one if needed.
            widths       (if grouped?
                           (reduce (fn [widths [start end]]
                                     (let [span (+ (reduce + (subvec widths start end))
                                                   (* gap (- end start 1)))
                                           need (+ gap (label-width (group-label (nth columns start))
                                                                    matrix-label-size))]
                                       (cond-> widths
                                         (< span need) (update (dec end) + (- need span)))))
                                   widths
                                   (runs columns 1))
                           widths)
            heights      (mapv (fn [row]
                                 (reduce max
                                         matrix-header-height
                                         (for [[[_ r] cells] members
                                               :when (= r row)]
                                           (stack-height cells))))
                               (range (count rows)))
            col-x        (grid-offsets widths gap)
            row-y        (grid-offsets heights gap)
            row-label-w  (mapv (fn [index]
                                 (+ 16 (reduce max 0 (map #(label-width (value-text (nth % index))
                                                                        matrix-label-size)
                                                          rows))))
                               (range (count row-axes)))
            corner       (when (seq row-axes)
                           (str (str/join " · " (map :name row-axes))
                                " / " (:name (peek column-axes))))
            corner-w     (if corner
                           (max (reduce + row-label-w)
                                (+ 16 (label-width corner matrix-label-size)))
                           0)
            summary      (set-summary component-set)
            header-y     (+ y padding matrix-summary-height)
            values-y     (+ header-y (* (dec (count column-axes)) matrix-header-height))
            cells-x      (+ x padding corner-w)
            cells-y      (+ header-y (* (count column-axes) matrix-header-height) matrix-label-gap)
            width        (max (+ (* 2 padding) (label-width summary matrix-label-size))
                              (+ (- cells-x x) (peek col-x) (or (peek widths) 0) padding))
            height       (+ (- cells-y y) (peek row-y) (or (peek heights) 0) padding)
            column-x     (fn [column] (+ cells-x (nth col-x column)))
            cell-y       (fn [row] (+ cells-y (nth row-y row)))]
        {:component-id component-id
         :component-set component-set
         :container {:x x :y y :width width :height height}
         :labels (vec
                  (concat
                   [(matrix-label summary (+ x padding) (+ y padding) :muted? true)]
                   (when grouped?
                     (map (fn [[start _]]
                            (matrix-label (group-label (nth columns start))
                                          (column-x start) header-y :weight 600))
                          (runs columns 1)))
                   (map-indexed (fn [column key]
                                  (matrix-label (value-text (peek key)) (column-x column) values-y))
                                columns)
                   (when corner
                     [(matrix-label corner (+ x padding) values-y :muted? true)])
                   ;; One header column per row axis; a value shows where it
                   ;; starts a run, like a pivot table.
                   (for [index (range (count row-axes))
                         [start _] (runs rows (inc index))]
                     (matrix-label (value-text (nth (nth rows start) index))
                                   (+ x padding (reduce + (subvec row-label-w 0 index)))
                                   (cell-y start)
                                   :weight (if (< index (dec (count row-axes))) 600 400)))))
         :placements (mapv (fn [{:keys [variant column row]}]
                             (place variant
                                    (column-x column)
                                    (+ (cell-y row) (get slot-y (:id variant) 0))))
                           cells)
         :width width
         :height height}))))

(defn- offset-component-set-block
  "Move an already computed block from the origin to its page position."
  [block x y]
  (let [offset (fn [position]
                 (-> position (update :x + x) (update :y + y)))]
    (cond-> (-> block
                (update :labels #(mapv offset %))
                (update :placements
                        #(mapv (fn [placement]
                                 (-> placement
                                     (update :offset-x + x)
                                     (update :offset-y + y)))
                               %)))
      (:container block)
      (update :container offset))))

(defn- ordered-component-sets
  "Component Sets in Package order: component entry order, then set order
  inside the entry."
  [snapshot]
  (->> (component-entries snapshot)
       (mapcat :componentSets)
       (filter :id)
       (mapv (juxt :id identity))))

(defn- located-components
  "Components defined on a screen (their main lives on that screen's page),
  in Package order."
  [snapshot]
  (->> (component-entries snapshot)
       (remove #(sequential? (:componentSets %)))
       (filterv :id)))

(defn- located-page-name
  [snapshot {:keys [screenId presentationId]}]
  (some (fn [screen]
          (when (= (:id screen) screenId)
            (some #(when (= (:id %) presentationId)
                     (presentation-page-name screen %))
                  (:presentations screen))))
        (map #(lookup (:entries snapshot) %)
             (get-in snapshot [:manifest :entries :screens]))))

(defn- located-card
  [snapshot component x y]
  (let [name  (str (:name component))
        page  (tr "smallpen.components-page.located-page"
                  (or (located-page-name snapshot component) "—"))
        width (max 220 (+ 32 (label-width name 14)) (+ 32 (label-width page matrix-label-size)))]
    {:width width
     :height 64
     :box {:x x :y y :width width :height 64}
     :labels [(matrix-label name (+ x 16) (+ y 12) :size 14 :weight 600)
              (matrix-label page (+ x 16) (+ y 36) :muted? true)]}))

(defn- flowed
  "Items built by `build` (fn [item x y]) at the places a greedy row flow
  gives them, and the y below the last row."
  [items build x y width gap]
  (let [{:keys [positions end-y]} (flow-layout items x y width gap gap)]
    {:items (mapv (fn [item [px py]] (build item px py)) items positions)
     :end-y (if (seq items) end-y y)}))

(defn- components-page-layout
  "The Components page from top to bottom: a header, one section per
  component category with its Component Sets flowed in rows (both in
  Package order; sets without a category come last), and a section of
  cards for the components defined on screens. Positions are derived from
  the Package on every projection and never stored."
  [snapshot]
  (let [sets      (ordered-component-sets snapshot)
        located   (located-components snapshot)
        category  #(let [value (str/trim (str (or (:category (second %)) "")))]
                     (when-not (str/blank? value) value))
        by-name   (->> (group-by category sets)
                       (sort-by (fn [[name _]]
                                  (if (some? name)
                                    (d/index-of (distinct (map category sets)) name)
                                    js/Number.MAX_SAFE_INTEGER))))
        blocks    (into {}
                        (map (fn [[component-id component-set]]
                               [component-id (component-set-block component-id component-set 0 0)]))
                        sets)
        sized     (fn [[component-id _]] (get blocks component-id))
        width     (reduce max page-content-width (map :width (vals blocks)))
        header    [(matrix-label (tr "smallpen.components-page.title") 0 0 :size 28 :weight 700)
                   (matrix-label (tr "smallpen.components-page.summary"
                                     (count sets)
                                     (reduce + (map #(count (:variants (second %))) sets))
                                     (count located))
                                 0 48 :size 13 :muted? true)
                   (matrix-label (tr "smallpen.components-page.edit-note") 0 72 :size 13 :muted? true)
                   (matrix-label (tr "smallpen.components-page.theme-note") 0 96 :size 13 :muted? true)]
        {:keys [sections y]}
        (reduce (fn [{:keys [y] :as acc} [name sets]]
                  (let [title  (or name (tr "smallpen.components-page.uncategorized"))
                        blocks (flowed (map sized sets)
                                       offset-component-set-block
                                       0 (+ y 88) width page-block-gap)]
                    (-> acc
                        (update :sections conj
                                {:key (str "section/" name)
                                 :name title
                                 :labels [(matrix-label title 0 y :size 22 :weight 600)]
                                 :rule {:x 0 :y (+ y 40) :width width :height 1}
                                 :blocks (:items blocks)})
                        (assoc :y (+ (:end-y blocks) page-section-gap)))))
                {:sections [] :y 200}
                by-name)
        cards     (when (seq located)
                    (flowed (map #(assoc (located-card snapshot % 0 0) :component %) located)
                            (fn [{:keys [component]} x y]
                              (assoc (located-card snapshot component x y) :component component))
                            0 (+ y 100) width 16))]
    {:header header
     :sections sections
     :blocks (vec (mapcat :blocks sections))
     :located (when cards
                {:labels [(matrix-label (tr "smallpen.components-page.located-title") 0 y
                                        :size 22 :weight 600)
                          (matrix-label (tr "smallpen.components-page.located-note") 0 (+ y 40)
                                        :size 13 :muted? true)]
                 :rule {:x 0 :y (+ y 64) :width width :height 1}
                 :cards (:items cards)})}))

(defn- variant-container-shape
  "The board Penpot draws around the variants of one Component Set: the
  variant container, named after the set, holding the variant mains with the
  first variant on top (Penpot's primary variant is the last child)."
  [snapshot {:keys [component-id component-set container placements]}]
  (let [container-id (runtime-id snapshot :components component-id)]
    (cts/setup-shape
     {:id container-id
      :type :frame
      :name (component-set-full-name component-set)
      :x (:x container)
      :y (:y container)
      :width (:width container)
      :height (:height container)
      :parent-id uuid/zero
      :frame-id uuid/zero
      :is-variant-container true
      :fills []
      :strokes [{:stroke-alignment :inner
                 :stroke-style :solid
                 :stroke-color "#bb97d8"
                 :stroke-opacity 1
                 :stroke-width 2}]
      :r1 20 :r2 20 :r3 20 :r4 20
      :shapes (->> placements
                   (map (fn [{:keys [variant]}]
                          (runtime-id snapshot
                                      :componentNodes
                                      component-id
                                      (:id variant)
                                      (:rootId variant))))
                   (reverse)
                   (vec))
      :plugin-data {:smallpen {"component-id" component-id}}})))

(defn- in-variant-container
  "The shapes of one variant main moved under its variant container: the
  root becomes a variant (Penpot names it after the container and derives
  its variant name from the property values), and shapes framed by the page
  are framed by the container instead."
  [shapes container-id component-set variant root-id]
  (into {}
        (map (fn [[id shape]]
               [id (cond-> shape
                     (= uuid/zero (:frame-id shape))
                     (assoc :frame-id container-id)

                     (= id root-id)
                     (assoc :parent-id container-id
                            :name (component-set-full-name component-set)
                            :variant-id container-id
                            :variant-name (ctv/properties-to-name
                                           (variant-properties component-set
                                                               variant))))]))
        shapes))

(def ^:private components-decoration
  {:smallpen {"components-page" "decoration"}})

(defn- components-decoration-id
  "Stable id of a Components page decoration: the page id with its low bits
  taken from hashes of `key`, so a reprojection keeps every label's id."
  [page-id key]
  (let [parts (uuid/get-unsigned-parts page-id)]
    (uuid/from-unsigned-parts (aget parts 0)
                              (aget parts 1)
                              (bit-or 0x80000000 (bit-and (hash key) 0x3fffffff))
                              (hash (str key "/")))))

(defn- decoration-label-shape
  [snapshot id parent-id {:keys [text x y size weight muted?]}]
  (let [{:keys [width height]} (board-text-metrics text size)]
    (cts/setup-shape
     {:id id
      :type :text
      :name text
      :x x :y y
      :width width
      :height height
      :grow-type :fixed
      :parent-id parent-id
      :frame-id uuid/zero
      :blocked true
      :content (project-text-content
                snapshot
                text
                [{:color (if muted? "#6b7280" "#111827") :type "solid"}]
                {:fontSize size :fontWeight weight}
                nil)
      :plugin-data components-decoration})))

(defn- decoration-box-shape
  [id name parent-id {:keys [x y width height]} fill stroke]
  (cts/setup-shape
   {:id id
    :type :rect
    :name name
    :x x :y y
    :width width
    :height height
    :parent-id parent-id
    :frame-id uuid/zero
    :blocked true
    :fills [{:fill-color fill :fill-opacity 1}]
    :strokes (if stroke
               [{:stroke-alignment :inner
                 :stroke-style :solid
                 :stroke-color stroke
                 :stroke-opacity 1
                 :stroke-width 1}]
               [])
    :r1 8 :r2 8 :r3 8 :r4 8
    :plugin-data components-decoration}))

(defn- decoration-group
  "A locked group of Components page decoration, flat: the group shape, then
  every shape inside it. Each part is a fn of the group id returning its
  child followed by the child's own descendants."
  [page-id key name parent-id parts]
  (let [id    (components-decoration-id page-id key)
        trees (mapv #(% id) parts)
        rect  (grc/join-rects (map (comp :selrect first) trees))]
    (into [(cts/setup-shape
            {:id id
             :type :group
             :name name
             :x (:x rect) :y (:y rect)
             :width (:width rect)
             :height (:height rect)
             :parent-id parent-id
             :frame-id uuid/zero
             :blocked true
             :shapes (mapv (comp :id first) trees)
             :plugin-data components-decoration})]
          cat
          trees)))

(defn- components-page-decorations
  "The locked label groups of the Components page, one per page part: the
  header, each category section (its title, a rule and one group of labels
  per Component Set) and the located components with their cards. They sit
  beside the variant containers, never inside them, and are never written
  back to the Package."
  [snapshot page-id {:keys [header sections located]}]
  (let [labels (fn [key labels]
                 (map-indexed (fn [index label]
                                (fn [parent]
                                  [(decoration-label-shape
                                    snapshot
                                    (components-decoration-id page-id (str key "/label/" index))
                                    parent
                                    label)]))
                              labels))
        box    (fn [key name rect fill stroke]
                 (fn [parent]
                   [(decoration-box-shape (components-decoration-id page-id key)
                                          name parent rect fill stroke)]))
        rule   (fn [key rect]
                 (box (str key "/rule") (tr "smallpen.components-page.divider") rect "#c9ccd4" nil))]
    (cond-> [(decoration-group page-id "header" (tr "smallpen.components-page.title")
                               uuid/zero (labels "header" header))]
      :always
      (into (map (fn [{:keys [key name blocks] :as section}]
                   (decoration-group
                    page-id key name uuid/zero
                    (concat (labels key (:labels section))
                            [(rule key (:rule section))]
                            (map (fn [{:keys [component-id component-set] :as block}]
                                   (fn [parent]
                                     (decoration-group
                                      page-id (str "set/" component-id)
                                      (tr "smallpen.components-page.labels-layer"
                                          (:name component-set))
                                      parent
                                      (labels (str "set/" component-id) (:labels block)))))
                                 blocks))))
                 sections))

      (some? located)
      (conj (decoration-group
             page-id "located" (tr "smallpen.components-page.located-title") uuid/zero
             (concat (labels "located" (:labels located))
                     [(rule "located" (:rule located))]
                     (mapcat (fn [{:keys [component] :as card}]
                               (let [key (str "located/" (:id component))]
                                 (cons (box key (str (:name component)) (:box card)
                                            "#ffffff" "#d1d5db")
                                       (labels key (:labels card)))))
                             (:cards located))))))))

(defn- project-components-page
  "One synthetic page holding the main instance of every Component Set variant.
  Penpot resolves a component through (main-instance-page, main-instance-id),
  so the shapes must live on a real page; this page exists only in the
  projection and is never written back to the Package. A set with axes is a
  native Penpot variant container (its axes are the variant properties).
  Locked label groups (`components-page-decorations`) make the page read as
  an overview of every component."
  [snapshot components {:keys [blocks] :as layout}]
  (let [page-id  (-> snapshot :runtime :componentsPage uuid/parse)
        labels   (components-page-decorations snapshot page-id layout)
        shapes   (reduce
                  (fn [acc {:keys [component-set placements] :as block}]
                    (let [container? (variant-container? component-set)
                          container  (when container?
                                       (variant-container-shape snapshot block))]
                      (reduce
                       (fn [acc {:keys [component-id variant] :as placement}]
                         (let [shapes (project-variant-shapes snapshot
                                                              components
                                                              placement)
                               root   (runtime-id snapshot
                                                  :componentNodes
                                                  component-id
                                                  (:id variant)
                                                  (:rootId variant))]
                           (merge acc
                                  (if container?
                                    (in-variant-container shapes
                                                          (:id container)
                                                          component-set
                                                          variant
                                                          root)
                                    shapes))))
                       (cond-> acc
                         container? (assoc (:id container) container))
                       placements)))
                  (into {} (comp cat (map (juxt :id identity))) labels)
                  blocks)
        root-ids (into (mapv (comp :id first) labels)
                       (map (fn [{:keys [component-id component-set placements]}]
                              (if (variant-container? component-set)
                                (runtime-id snapshot :components component-id)
                                (let [{:keys [variant]} (first placements)]
                                  (runtime-id snapshot
                                              :componentNodes
                                              component-id
                                              (:id variant)
                                              (:rootId variant)))))
                            (filter #(or (variant-container? (:component-set %))
                                         (seq (:placements %)))
                                    blocks)))
        root-shape (-> (get-in ctp/empty-page-data [:objects uuid/zero])
                       (assoc :shapes root-ids))]
    (-> (ctp/make-empty-page {:id page-id :name "Components"})
        (assoc :objects (assoc shapes uuid/zero root-shape))
        (assoc :plugin-data {:smallpen {"components-page" true}}))))

(defn- design-system-ref-data
  "Source identity of a generated design-system shape, stored in its
  plugin-data as JSON. The change adapter maps native edits back to the
  source (token Cell / component definition); decorations carry no target."
  [ref]
  (js/JSON.stringify (clj->js ref)))

(defn- design-system-refs
  "Backend-computed source identities for the generated page (DSE-004, the
  single source of truth shared with the write-back adapter). Nil when the
  serving backend predates designSystemRefs."
  [snapshot]
  ;; js->clj :keywordize-keys keeps the camelCase JSON key.
  (get-in snapshot [:runtime :designSystemRefs]))

(defn- css-color->attrs
  "Parse a css color (hex or rgb()/rgba() string) into the native shadow
  color attrs {:color hex :opacity}, or nil when unparsable."
  [value]
  (let [s    (some-> value str str/trim)
        rgba (re-matches #"rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)"
                         (or s ""))
        hex2 (fn [n]
               (let [h (.toString (js/Math.round (js/Math.min 255 (js/Math.max 0 n))) 16)]
                 (if (< (count h) 2) (str "0" h) h)))]
    (cond
      rgba
      {:color (str "#" (hex2 (js/parseFloat (nth rgba 1)))
                   (hex2 (js/parseFloat (nth rgba 2)))
                   (hex2 (js/parseFloat (nth rgba 3))))
       :opacity (or (some-> (nth rgba 4) js/parseFloat) 1)}

      (and (string? s) (str/starts-with? s "#"))
      (let [hex (subs s 1)]
        (case (count hex)
          3 {:color s :opacity 1}
          6 {:color s :opacity 1}
          8 {:color (str "#" (subs hex 0 6))
             :opacity (/ (js/parseInt (subs hex 6 8) 16) 255)}
          nil)))))

(defn- board-text-metrics
  [text size]
  (let [lines (str/split (str text) "\n")]
    {:width (max 80 (* size (apply max 0 (map (fn [line]
                                                (reduce + 0 (map #(if (> (.charCodeAt % 0) 255) 1 0.62) line)))
                                              lines))))
     :height (max 18 (* 1.4 size (max 1 (count lines))))}))

(declare board-text)

(defn- mark-design-system-source
  "Tag a projected tree shape with the source identity of its component
  definition node (informational: the write path resolves through runtime
  ids)."
  [shape ref]
  (update-in shape [:plugin-data :smallpen]
             (fn [base]
               (merge (or base {})
                      {"design-system" "source"
                       "design-system-kind" "component-definition"
                       "design-system-ref" (design-system-ref-data ref)}))))

(defn- project-located-tree
  "Board copy of a located component's main tree (DSE-R11). Shape ids are the
  SAME runtime ids as the source screen nodes, so native edits on the copy
  resolve to that very node through the backend's reverseDesignSystem map —
  no second id space and no duplicated source. The tree origin lands exactly
  on (offset-x offset-y); shapes are built at their final coordinates."
  [snapshot components {:keys [component-id screen-id presentation-id
                               main-node-id]}]
  (let [presentation (screen-presentation snapshot screen-id presentation-id)
        nodes      (:nodes presentation)
        tree       (subtree-nodes nodes main-node-id)
        parents    (parent-index tree)
        node-path  [:nodes screen-id presentation-id]
        base-origins (absolute-origins tree [main-node-id])
        [root-x root-y] (root-origin base-origins tree main-node-id)
        ;; Where the source screen itself draws the main node: the subtree
        ;; origins above leave out the ancestors' placement.
        [source-x source-y] (root-origin (absolute-origins nodes (presentation-root-ids presentation))
                                         nodes
                                         main-node-id)
        cmp-id     (runtime-id snapshot :components component-id)
        file-id    (-> snapshot :runtime :file uuid/parse)]
    (fn [offset-x offset-y]
      (let [origins     (shift-origins base-origins
                                       (- offset-x root-x)
                                       (- offset-y root-y))
            plugin-data (with-layout-offset
                          #(screen-plugin-data screen-id presentation-id %)
                          (- offset-x source-x)
                          (- offset-y source-y))]
        (->> (vals tree)
             (map (fn [node]
                    (cond->
                     (project-node snapshot
                                   components
                                   node-path
                                   plugin-data
                                   origins
                                   tree
                                   parents
                                   #{main-node-id}
                                   node)
                      (= (:id node) main-node-id)
                      (assoc :component-id cmp-id
                             :component-file file-id
                             :component-root true
                             :main-instance true))))
             (vec))))))

(defn- project-family-tree
  "Builder (fn [x y] -> shapes) for one component family entry's native tree.
  Variant families reuse the componentNodes projection (the same shapes the
  Components page carries); located families project the source screen
  subtree."
  [snapshot components placements {:keys [kind componentSetId componentId
                                          variantId screenId presentationId
                                          mainNodeId nodeCount]}]
  (case kind
    "variant"
    (let [{:keys [component-set] :as placement}
          (some (fn [{:keys [component-id variant] :as candidate}]
                  (when (and (= componentSetId component-id)
                             (= variantId (:id variant)))
                    candidate))
                placements)
          build (when placement
                  (let [offsets (fn [x y]
                                  (assoc placement :offset-x x :offset-y y))]
                    (fn [x y]
                      (->> (project-variant-shapes snapshot
                                                   components
                                                   (offsets x y))
                           (vals)
                           (vec)))))]
      (when build
        {:root-id (some (fn [{:keys [component-id variant]}]
                          (when (and (= componentSetId component-id)
                                     (= variantId (:id variant)))
                            (runtime-id snapshot
                                        :componentNodes
                                        component-id
                                        (:id variant)
                                        (:rootId variant))))
                        placements)
         :build build
         :ref {:kind "component-definition"
               :componentSetId componentSetId
               :ownerPackageId (-> snapshot :manifest :packageId)
               :sourceNodeId (-> placement :variant :rootId)
               :variantId variantId}}))

    "located"
    (let [build (when (and componentId screenId presentationId mainNodeId
                           (pos? (or nodeCount 0)))
                  (project-located-tree snapshot
                                        components
                                        {:component-id componentId
                                         :screen-id screenId
                                         :presentation-id presentationId
                                         :main-node-id mainNodeId}))]
      (when build
        {:root-id (runtime-id snapshot :nodes screenId presentationId mainNodeId)
         :build build
         :ref {:kind "component-definition"
               :componentId componentId
               :ownerPackageId (-> snapshot :manifest :packageId)
               :screenId screenId
               :sourceNodeId mainNodeId}}))

    nil))

(defn- board-text
  "Decoration text shape built at its final position. The LAYER name is
  prefixed so caption rows never collide with the component roots they
  introduce. grow-type stays :fixed with a conservative pre-measured width:
  auto-width texts make the renderer fire measure/resize follow-ups that
  pollute the user's undo history on generated pages (DSE-R11)."
  [snapshot id text x y {:keys [size opacity plain-name? weight]
                         :or {size 14 opacity 1 plain-name? false}}]
  (let [{:keys [width height]} (board-text-metrics text size)]
    (cts/setup-shape
     {:id id
      :type :text
      :name (if plain-name? text (str "Label · " text))
      :x x :y y
      :width width
      :height height
      :grow-type :fixed
      :parent-id uuid/zero
      :content
      (project-text-content
       snapshot
       text
       [{:color "#111827" :type "solid"}]
       {:fontFamily "Inter"
        :fontId "gfont-inter"
        :fontSize size
        :fontVariantId "regular"
        :fontWeight (or weight (if (= size 20) 600 400))}
       nil)
      :opacity opacity
      :plugin-data
      {:smallpen {"design-system" "decoration"}}})))

(defn- flow-layout
  "Greedy wrapped-row layout for already-measured items. Returns a vector of
  [x y] positions aligned with items; items wider than content-width are
  still placed on their own row (nothing is dropped), and rows advance by
  the tallest item they contain."
  [items start-x start-y content-width row-gap column-gap]
  (loop [items       items
         positions   []
         cursor-x    start-x
         cursor-y    start-y
         row-height  0
         row-max-x   start-x]
    (if-let [{:keys [width height]} (first items)]
      (let [wrap? (and (> cursor-x start-x)
                       (> (+ cursor-x width) (+ start-x content-width)))]
        (if wrap?
          (recur items positions start-x (+ cursor-y row-height row-gap) 0 row-max-x)
          (recur (rest items)
                 (conj positions [cursor-x cursor-y])
                 (+ cursor-x width column-gap)
                 cursor-y
                 (max row-height height)
                 (max row-max-x (+ cursor-x width)))))
      {:positions positions
       :end-y (+ cursor-y row-height)
       :max-x row-max-x})))

(defn- decoration-id
  "Fresh id for a generated label (a sample that cannot be drawn). Labels
  are rebuilt on every re-projection and are never canonical."
  []
  (uuid/next))

(defn- component-sample-shapes
  [snapshot components family x y]
  (let [set-key         (keyword (:componentSetId family))
        variant-key     (keyword (:variantId family))
        sample-snapshot (cond-> (assoc-in snapshot [:runtime :componentNodes set-key variant-key]
                                          (:runtimeNodes family))
                          ;; A Foundation set shown on a Product's page has no
                          ;; component in this file; the sample drops it anyway.
                          (nil? (get-in snapshot [:runtime :variants set-key variant-key]))
                          (assoc-in [:runtime :variants set-key variant-key] (str (uuid/next))))]
    (if (:error family)
      [(board-text snapshot (decoration-id) (:error family) x y {:size 14})]
      (let [node-ids (into {}
                           (map (fn [[id runtime-id]] [(uuid/parse runtime-id) (name id)]))
                           (:runtimeNodes family))]
        (map (fn [shape]
               (let [node-id (get node-ids (:id shape))
                     ref     (lookup (:sources family) node-id)]
                 (mark-design-system-source
                  (dissoc shape :component-id :component-file :component-root :main-instance :shape-ref)
                  (assoc ref :kind "component-definition" :sourceNodeId (:nodeId ref)))))
             (vals (project-variant-shapes
                    sample-snapshot components
                    {:component-id (:componentSetId family)
                     :variant {:id (:variantId family) :rootId (:rootId family) :nodes (:nodes family)}
                     :offset-x x :offset-y y})))))))

(defn- adopt-and-build-board
  "Shared tail of the generated page projection: adopt top-level shapes by
  the board frame (descendants keep their internal parent chain), derive the
  board extent and assemble the page object (DSE-003/DSE-R08)."
  [snapshot page-id board all-shapes board-name]
  (let [child-parents (into {}
                            (mapcat (fn [shape]
                                      (map (fn [child-id]
                                             [child-id (:id shape)])
                                           (:shapes shape))))
                            all-shapes)
        shapes-by-id  (into {} (map (juxt :id identity)) all-shapes)
        adopted       (mapv (fn [shape]
                              (if-let [parent-id (get child-parents (:id shape))]
                                (let [parent (get shapes-by-id parent-id)]
                                  (cond-> (assoc shape :parent-id parent-id)
                                    (= uuid/zero (:frame-id shape))
                                    (assoc :frame-id (if (= :frame (:type parent))
                                                       parent-id
                                                       board))))
                                (if (= uuid/zero (:parent-id shape))
                                  (assoc shape :parent-id board :frame-id board)
                                  shape)))
                            all-shapes)
        board-extent  (reduce (fn [[w h] shape]
                                [(max w (+ (:x shape) (or (:width shape) 0)))
                                 (max h (+ (:y shape) (or (:height shape) 0)))])
                              [0 0]
                              adopted)
        board-shape   (cts/setup-shape
                       {:id board
                        :type :frame
                        :name board-name
                        :x 0 :y 0
                        :width (max (+ (first board-extent) 40) 480)
                        :height (max (+ (second board-extent) 40) 240)
                        :parent-id uuid/zero
                        :fills [{:fill-color "#eef1f5" :fill-opacity 1}]
                        :shapes (into []
                                      (comp (filter #(= board (:parent-id %)))
                                            (map :id))
                                      adopted)
                        :plugin-data
                        {:smallpen {"design-system" "decoration"}}})
        objects       (into {board board-shape}
                            (map (fn [shape] [(:id shape) shape]))
                            adopted)]
    (-> (ctp/make-empty-page {:id page-id :name board-name})
        (assoc :objects
               (assoc objects uuid/zero
                      (-> (get-in ctp/empty-page-data [:objects uuid/zero])
                          (assoc :shapes [board]))))
        (assoc :plugin-data {:smallpen {"design-system-page" true}}))))

(defn- design-system-tree
  "The generated Design System page as one node tree, laid out by SmallPen
  core (design-system-page.mjs) and drawn identically by the CLI renderer.
  Nil when the serving backend predates it."
  [snapshot]
  (get-in snapshot [:runtime :designSystemTree]))

(defn- design-system-plugin-data
  "Write target of one page node: a token specimen maps to its Token Cell
  through refs.specimens; every other node is a decoration."
  [refs node]
  (let [{:keys [role specimen]} (:designSystem node)
        ref (when (= "token-cell" role)
              (lookup (:specimens refs) specimen))]
    (if ref
      {:smallpen {"design-system" "source"
                  "design-system-kind" "token-cell"
                  "design-system-ref" (design-system-ref-data ref)}}
      {:smallpen {"design-system" "decoration"}})))

(defn- design-system-tree-shapes
  "Penpot shapes for the page tree below its root. Sample and located
  placeholders become the component's own shapes at their spot."
  [snapshot placements refs {:keys [nodes rootId runtimeIds]}]
  (let [snapshot   (assoc-in snapshot [:runtime :designSystemNodes] runtimeIds)
        components (component-index snapshot)
        parents    (parent-index nodes)
        origins    (absolute-origins nodes [rootId])
        position   (fn [node]
                     (geometry-origin (lookup origins (:id node))
                                      (or (:width node) 0)
                                      (or (:height node) 0)))
        plugin-data (fn [id] (design-system-plugin-data refs (lookup nodes id)))
        ;; Layer order is the tree's: the board lists its shapes in the order
        ;; they come, bottom to top, so card shells stay under their content.
        ordered    (letfn [(walk [id]
                             (when-let [node (lookup nodes id)]
                               (cons node (mapcat walk (:children node)))))]
                     (mapcat walk (:children (lookup nodes rootId))))]
    (into []
          (mapcat
           (fn [node]
             (let [{:keys [role sample family]} (:designSystem node)]
               (cond
                 (= "component-sample" role)
                 (if-let [item (nth (:componentSamples refs) sample nil)]
                   (let [[x y] (position node)]
                     (component-sample-shapes snapshot components item x y))
                   [])

                 (= "located-family" role)
                 (if-let [{:keys [build ref]} (some->> (nth (:families refs) family nil)
                                                       (project-family-tree snapshot components placements))]
                   (let [[x y] (position node)]
                     (map #(mark-design-system-source % ref) (build x y)))
                   [])

                 :else
                 [(project-node snapshot components [:designSystemNodes] plugin-data
                                origins nodes parents #{rootId} node)]))))
          ordered)))

(defn- project-design-system-page
  "Generated Design System page inside the normal workspace projection
  (DSE-003): every Token Cell and representative component samples. The
  page exists only in the projection and is never written back to the
  Package; decorations carry no write target."
  [snapshot placements]
  (when (some? (get-in snapshot [:runtime :designSystemPage]))
    (let [page-id (uuid/parse (get-in snapshot [:runtime :designSystemPage]))
          board   (runtime-id snapshot :designSystem :board)
          refs    (or (design-system-refs snapshot) {})
          tree    (design-system-tree snapshot)
          shapes  (if tree
                    (design-system-tree-shapes snapshot placements refs tree)
                    [])]
      ;; Preview selection changes only the generated page, never its sources.
      (adopt-and-build-board snapshot page-id board shapes
                             (tr "smallpen.design-system")))))

(defn- project-component-sets
  "One Penpot component per variant, named after its Component Set. The
  variants of a set with axes belong to its variant container (:variant-id)
  and carry the axis values as variant properties."
  [snapshot blocks]
  (into {}
        (mapcat
         (fn [{:keys [component-id component-set placements]}]
           (let [container-id (when (variant-container? component-set)
                                (runtime-id snapshot :components component-id))]
             (map (fn [{:keys [variant]}]
                    (let [cmp-id (runtime-id snapshot
                                             :variants
                                             component-id
                                             (:id variant))]
                      [cmp-id
                       (cond-> {:id cmp-id
                                :name (:name component-set)
                                :path (component-set-path component-set)
                                :main-instance-id (runtime-id snapshot
                                                              :componentNodes
                                                              component-id
                                                              (:id variant)
                                                              (:rootId variant))
                                :main-instance-page (-> snapshot
                                                        :runtime
                                                        :componentsPage
                                                        uuid/parse)}
                         (some? container-id)
                         (assoc :variant-id container-id
                                :variant-properties (variant-properties
                                                     component-set
                                                     variant)))]))
                  placements))))
        blocks))

(defn- project-located-components
  [snapshot components]
  (into {}
        (map (fn [[component-id {:keys [mainNodeId name path
                                        presentationId screenId]}]]
               (let [cmp-id (runtime-id snapshot :components component-id)]
                 [cmp-id
                  {:id cmp-id
                   :name name
                   :path path
                   :main-instance-id (runtime-id snapshot
                                                 :nodes
                                                 screenId
                                                 presentationId
                                                 mainNodeId)
                   :main-instance-page (runtime-id snapshot
                                                   :pages
                                                   screenId
                                                   presentationId)}])))
        components))

(defn project-snapshot
  [snapshot {:keys [file-id libraries project-id]}]
  (validate-capabilities! snapshot)
  (let [snapshot   (assoc snapshot :libraries (or libraries []))
        manifest   (:manifest snapshot)
        components (component-index snapshot)
        sets       (component-set-index snapshot)
        placements (variant-placements sets)
        layout     (components-page-layout snapshot)
        assets     (asset-library snapshot)
        dtcg-tokens (snapshot-dtcg-token-definitions snapshot)
        library    (token-library snapshot)
        foundation (foundation-token-part snapshot)
        ;; A Product shows its Foundation's sets and themes first, then its
        ;; own, with its own selection of the Foundation's themes.
        tokens-lib (cond
                     (some? foundation)
                     (project-token-parts
                      (cond-> [foundation]
                        (some? library)
                        (conj {:owner snapshot
                               :library library
                               :active-theme-ids (:activeThemeIds library)})))

                     (some? library)
                     (project-token-library snapshot library)

                     (seq dtcg-tokens)
                     (ctob/make-tokens-lib)

                     :else
                     (default-token-library))
        tokens-lib (add-dtcg-token-set snapshot tokens-lib dtcg-tokens)
        screens      (into {}
                           (map (fn [entry]
                                  (let [screen (lookup (:entries snapshot) entry)]
                                    [(:id screen) screen])))
                           (get-in manifest [:entries :screens]))
        ;; Canvases come from the Background (core canvases.mjs), in order.
        screen-pages (mapv #(project-canvas snapshot components screens %)
                           (get-in snapshot [:runtime :canvases]))
        pages    (cond-> screen-pages
                   (and (some? (-> snapshot :runtime :componentsPage))
                        (or (seq (:blocks layout)) (some? (:located layout))))
                   (conj (project-components-page snapshot
                                                  components
                                                  layout))
                   (some? (-> snapshot :runtime :designSystemPage))
                   (conj (project-design-system-page snapshot placements)))
        data     (-> (ctf/make-file-data file-id nil)
                     (assoc :pages (mapv :id pages))
                     (assoc :pages-index (into {} (map (juxt :id identity)) pages))
                     (assoc :components
                            (merge (project-located-components snapshot components)
                                   (project-component-sets snapshot (:blocks layout))))
                     (cond-> (some? assets)
                       (assoc :colors
                              (project-color-library snapshot
                                                     (:colors assets))
                              :media
                              (project-media-library snapshot
                                                     (:media assets))
                              :typographies
                              (project-typography-library
                               snapshot
                               (:typographies assets))))
                     (assoc :tokens-lib tokens-lib
                            :tokens-status (cfo/make-tokens-status-from-lib tokens-lib))
                     (assoc :plugin-data
                            {:smallpen
                             (cond-> {"locator" (:locator snapshot)
                                      "package-id" (:packageId manifest)
                                      "revision" (:revision snapshot)}
                               (some? foundation)
                               (assoc "foundation-tokens"
                                      (foundation-token-data foundation)))}))
        file     (-> (ctf/make-file
                      {:id file-id
                       :project-id project-id
                       :name (:name manifest)
                       :features features/default-features
                       :metadata {:generated-by "smallpen"}}
                      :create-page false)
                     (assoc :backend :smallpen)
                     (assoc :permissions
                            {:type :membership
                             :is-owner true
                             :is-admin true
                             :can-edit (not (true? (get-in snapshot
                                                           [:packageStatus
                                                            :readOnly])))
                             :can-read true
                             :is-logged true})
                     (assoc :data data))]
    {:file file
     :runtime (:runtime snapshot)}))
