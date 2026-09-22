;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.projection
  (:require
   [app.main.smallpen.token-state :as spts]
   [app.common.features :as features]
   [app.common.files.tokens :as cfo]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.types.file :as ctf]
   [app.common.types.modifiers :as ctm]
   [app.common.types.page :as ctp]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [cuerdas.core :as str]))

(def format-capabilities
  {:appliedTokenAttributes ["column-gap"
                            "fill"
                            "font-family"
                            "font-size"
                            "font-weight"
                            "height"
                            "layout-item-max-h"
                            "layout-item-max-w"
                            "layout-item-min-h"
                            "layout-item-min-w"
                            "letter-spacing"
                            "line-height"
                            "m1"
                            "m2"
                            "m3"
                            "m4"
                            "opacity"
                            "p1"
                            "p2"
                            "p3"
                            "p4"
                            "r1"
                            "r2"
                            "r3"
                            "r4"
                            "rotation"
                            "row-gap"
                            "shadow"
                            "stroke-color"
                            "stroke-width"
                            "text-case"
                            "text-decoration"
                            "typography"
                            "width"]
   :componentModel "located-main-instance"
   :cornerRadiusForms ["uniform" "per-corner"]
   :entryKinds ["assets" "components" "screens" "tokens"]
   :fillTypes ["image" "linear-gradient" "radial-gradient" "solid"]
   :localAssetTypes ["color" "font" "media" "typography"]
   :nodeFields ["appliedTokens"
                "backgroundBlur"
                "blend-mode"
                "blur"
                "children"
                "componentId"
                "componentVariantId"
                "cornerRadius"
                "fills"
                "flipX"
                "flipY"
                "growType"
                "grids"
                "height"
                "hide-fill-on-export"
                "hide-in-viewer"
                "id"
                "interactions"
                "layout"
                "layout-flex-dir"
                "layout-gap-type"
                "layout-gap"
                "layout-align-items"
                "layout-justify-content"
                "layout-align-content"
                "layout-wrap-type"
                "layout-padding-type"
                "layout-padding"
                "layout-item-margin"
                "layout-item-margin-type"
                "layout-item-h-sizing"
                "layout-item-v-sizing"
                "layout-item-max-h"
                "layout-item-min-h"
                "layout-item-max-w"
                "layout-item-min-w"
                "layout-item-align-self"
                "layout-item-absolute"
                "layout-item-z-index"
                "constraints-h"
                "constraints-v"
                "fixed-scroll"
                "exports"
                "content"
                "pathData"
                "points"
                "locked"
                "masked-group"
                "mediaRef"
                "name"
                "opacity"
                "proportionLock"
                "rotation"
                "sourceNodeId"
                "strokes"
                "shadow"
                "show-content"
                "text"
                "textBlocks"
                "textStyle"
                "touched"
                "type"
                "visible"
                "width"
                "x"
                "y"]
   :nodeTypes ["COMPONENT" "ELLIPSE" "FRAME" "GROUP" "IMAGE" "INSTANCE" "PATH" "RECTANGLE" "TEXT"]
   :presentationRootForms ["legacy-single" "forest"]
   :textModel "blocks-runs"
   :strokeTypes ["image" "linear-gradient" "radial-gradient" "solid"]
   :supportedFontTypes ["font/otf" "font/ttf" "font/woff" "font/woff2"]
   :supportedMediaTypes ["image/gif"
                         "image/jpeg"
                         "image/png"
                         "image/svg+xml"
                         "image/webp"]
   :assetLibraryEntries "zero-or-one"
   :tokenLibraryEntries "zero-or-one"
   :touchedGroups ["blur-group"
                   "constraints-group"
                   "content-group"
                   "fill-group"
                   "geometry-group"
                   "layer-effects-group"
                   "mask-group"
                   "modifiable-group"
                   "name-group"
                   "radius-group"
                   "shadow-group"
                   "stroke-group"
                   "text-display-group"
                   "text-font-group"
                   "visibility-group"]})

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
                     colorRef style type width] :as stroke}]
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

(defn- absolute-origins
  "SmallPen node x/y are relative to the parent node; Penpot shape x/y are
  absolute within the page. Accumulate each ancestor's offset so both models
  agree. offsets shifts the whole tree, used to lay variants out side by side."
  ([nodes root-ids] (absolute-origins nodes root-ids 0 0))
  ([nodes root-ids offset-x offset-y]
   (letfn [(walk [origins node-id parent-x parent-y]
             (if-let [node (lookup nodes node-id)]
               (let [x (+ parent-x (or (:x node) 0))
                     y (+ parent-y (or (:y node) 0))]
                 (reduce (fn [acc child-id] (walk acc child-id x y))
                         (assoc origins node-id [x y])
                         (:children node)))
               origins))]
     (reduce (fn [origins root-id] (walk origins root-id offset-x offset-y))
             {}
             root-ids))))

(defn- node-runtime-id
  "Resolve one node's runtime UUID. node-path is the runtime lookup prefix:
  [:nodes screen-id presentation-id] for Screen nodes, or
  [:componentNodes component-id variant-id] for Component Set variant nodes."
  [snapshot node-path node-id]
  (apply runtime-id snapshot (conj (vec node-path) node-id)))

(defn- nearest-frame-id
  [snapshot node-path nodes parents node-id]
  (loop [parent-id (get parents node-id)]
    (if parent-id
      (let [parent (lookup nodes parent-id)]
        (if (= "FRAME" (:type parent))
          (node-runtime-id snapshot node-path parent-id)
          (recur (get parents parent-id))))
      uuid/zero)))

(defn- screen-plugin-data
  [screen-id presentation-id node-id]
  {:smallpen
   {"node-id" node-id
    "presentation-id" presentation-id
    "screen-id" screen-id}})

(defn- shift-origins
  "Translate every accumulated origin by (delta-x delta-y). Used to place a
  projected subtree at an exact board position: shapes must be BUILT at their
  final x/y (setup-shape derives selrect/points from them), never moved
  afterwards (DSE-R08)."
  [origins delta-x delta-y]
  [origins delta-x delta-y]
  (into {}
        (map (fn [[node-id [x y]]]
               [node-id [(+ x delta-x) (+ y delta-y)]]))
        origins))

(defn- subtree-nodes
  "The nodes reachable from root-id, keyed by id."
  [nodes root-id]
  (letfn [(walk [acc node-id]
            (if-let [node (lookup nodes node-id)]
              (reduce walk (assoc acc node-id node) (:children node))
              acc))]
    (walk {} root-id)))

(defn- subtree-size
  "Width/height of a node subtree relative to its root origin, so board
  cells reserve the right space before the shapes are built."
  [nodes root-id]
  (let [origins (absolute-origins nodes [root-id])
        root    (lookup nodes root-id)
        [rx ry] (or (lookup origins root-id) [(or (:x root) 0) (or (:y root) 0)])]
    (reduce
     (fn [[width height] [node-id [x y]]]
       (let [node (lookup nodes node-id)]
         [(max width (+ (- x rx) (or (:width node) 0)))
          (max height (+ (- y ry) (or (:height node) 0)))]))
     [0 0]
     origins)))

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

(defn- project-token-library
  [snapshot {:keys [activeSetIds activeThemeIds sets themes]}]
  (let [set-names (into {} (map (juxt :id :name)) sets)
        token-sets
        (mapv (fn [{:keys [description id name tokens]}]
                (ctob/make-token-set
                 {:description description
                  :id (runtime-id snapshot :tokenSets id)
                  :name name
                  :tokens
                  (into {}
                        (map (fn [{:keys [description id name type value]}]
                               [name
                                (ctob/make-token
                                 {:description description
                                  :id (runtime-id snapshot :tokens id)
                                  :name name
                                  :type (keyword type)
                                  :value value})]))
                        tokens)}))
              sets)
        token-themes
        (mapv (fn [{:keys [description externalId group id isSource name setIds]}]
                (ctob/make-token-theme
                 {:description description
                  :external-id externalId
                  :group group
                  :id (runtime-id snapshot :tokenThemes id)
                  :is-source isSource
                  :name name
                  :sets (set (map #(lookup set-names %) setIds))}))
              themes)
        themes-by-id (into {} (map vector (map :id themes) token-themes))
        active-set-names (set (map #(lookup set-names %) activeSetIds))
        result (reduce ctob/add-set (ctob/make-tokens-lib) token-sets)
        result (ctob/update-theme
                result
                uuid/zero
                (fn [_]
                  (ctob/make-hidden-theme :sets active-set-names)))
        result (reduce ctob/add-theme result token-themes)
        active-theme-paths
        (if (seq activeThemeIds)
          (set (map #(ctob/get-theme-path (lookup themes-by-id %))
                    activeThemeIds))
          #{ctob/hidden-theme-path})]
    (spts/set-active-themes result active-theme-paths)))

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
                      (into {}
                            (map (fn [{:keys [description id name type value]}]
                                   [name
                                    (ctob/make-token
                                     {:description description
                                      :id (runtime-id snapshot :tokens id)
                                      :name name
                                      :type (keyword type)
                                      :value value})]))
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

(defn- project-transforms
  [shape rotation flip-x? flip-y?]
  (let [shape (if flip-x?
                (gsh/transform-shape
                 shape
                 (ctm/resize-modifiers (gpt/point -1 1)
                                       (gsh/shape->center shape)))
                shape)
        shape (if flip-y?
                (gsh/transform-shape
                 shape
                 (ctm/resize-modifiers (gpt/point 1 -1)
                                       (gsh/shape->center shape)))
                shape)]
    (if (and (number? rotation) (not (zero? rotation)))
      (gsh/transform-shape
       shape
       (ctm/rotation-modifiers shape (gsh/shape->center shape) rotation))
      shape)))

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

(defn- project-node
  [snapshot components node-path plugin-data-fn origins nodes parents root-ids node]
  (let [{:keys [appliedTokens backgroundBlur blend-mode blur children componentId
                componentVariantId content
                cornerRadius exports fills fixed-scroll flipX flipY growType
                grids height hide-fill-on-export hide-in-viewer id interactions
                layout layout-align-content layout-align-items
                layout-flex-dir layout-gap layout-gap-type layout-item-absolute
                layout-item-align-self layout-item-h-sizing layout-item-margin
                layout-item-margin-type layout-item-max-h layout-item-max-w
                layout-item-min-h layout-item-min-w layout-item-v-sizing
                layout-item-z-index layout-justify-content layout-padding
                layout-padding-type layout-wrap-type locked masked-group mediaRef name opacity
                pathData points proportionLock rotation shadow sourceNodeId
                show-content strokes text textBlocks textStyle touched type visible width x y
                constraints-h constraints-v]} node
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
        [abs-x abs-y] (or (lookup origins id) [x y])]
    (project-transforms
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
        (assoc :shadow shadow)

        (some? blend-mode)
        (assoc :blend-mode (keyword blend-mode))

        (some? grids)
        (assoc :grids grids)

        (some? hide-fill-on-export)
        (assoc :hide-fill-on-export hide-fill-on-export)

        (some? hide-in-viewer)
        (assoc :hide-in-viewer hide-in-viewer)

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

        ;; Canonical pathData is local to the node origin, but Penpot path
        ;; content is in page-absolute coordinates: translate the parsed
        ;; segments so selrect/content/x agree (setup-path derives the selrect
        ;; from content).
        (and (= type "PATH") (or (some? pathData) (some? content)))
        (assoc :content (-> (path/from-string (or pathData content))
                            (path/move-content (gpt/point abs-x abs-y))))

        (and (= type "PATH") (some? pathData))
        (assoc :path-data pathData)

        (and (= type "PATH") (seq points))
        (assoc :points (mapv (fn [{:keys [x y]}]
                               (gpt/point x y))
                             points))

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

        (some? appliedTokens)
        (assoc :applied-tokens
               (into {}
                     (map (fn [[attribute token-name]]
                            [(keyword attribute) token-name]))
                     appliedTokens))

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
        (assoc :touched (set (map keyword touched)))))
     rotation
     flipX
     flipY)))

(defn- project-page
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
                             (into {}))
        root-shape      (-> (get-in ctp/empty-page-data [:objects uuid/zero])
                            (assoc :shapes
                                   (mapv #(node-runtime-id snapshot node-path %)
                                         root-ids)))
        flows           (project-prototype-flows snapshot
                                                 screen-id
                                                 presentation-id
                                                 (:prototypeFlows presentation))]
    (-> (ctp/make-empty-page
         {:id page-id
          :name (if (= (:name screen) (:name presentation))
                  (:name screen)
                  (str (:name screen) " · " (:name presentation)))})
        (cond-> (some? (:background presentation))
          (assoc :background (:background presentation))

          (some? (:pixel-grid-color presentation))
          (assoc :pixel-grid-color (:pixel-grid-color presentation))

          (some? (:pixel-grid-opacity presentation))
          (assoc :pixel-grid-opacity (:pixel-grid-opacity presentation)))
        (assoc :objects (assoc shapes uuid/zero root-shape))
        (cond-> (seq flows)
          (assoc :flows flows))
        (assoc :plugin-data
               {:smallpen
                {"presentation-id" presentation-id
                 "screen-id" screen-id}}))))

(def ^:private component-grid-gap 80)
(def ^:private component-grid-columns 6)

(defn- variant-label
  "A readable name for one variant, built from its axis selection. A Component
  Set with no axes has a single variant that just carries the set name."
  [component-set variant]
  (let [selection (:selection variant)
        parts     (->> (:axes component-set)
                       (keep (fn [axis]
                               (when-let [value (lookup selection (:id axis))]
                                 (str (:name axis) "=" value)))))]
    (if (seq parts)
      (str/join ", " parts)
      (:name component-set))))

(defn- variant-placements
  "Lay every variant of every Component Set out on one grid so their main
  instances never overlap. One entry per variant, in a stable order."
  [component-sets]
  (->> component-sets
       (sort-by key)
       (mapcat (fn [[component-id component-set]]
                 (map (fn [variant]
                        {:component-id component-id
                         :component-set component-set
                         :variant variant})
                      (:variants component-set))))
       (map-indexed
        (fn [index {:keys [variant] :as placement}]
          (let [root   (lookup (:nodes variant) (:rootId variant))
                column (mod index component-grid-columns)
                row    (quot index component-grid-columns)]
            (assoc placement
                   :root root
                   :offset-x (* column (+ component-grid-gap (or (:width root) 0)))
                   :offset-y (* row (+ component-grid-gap (or (:height root) 0)))))))
       (vec)))

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
        [root-x root-y] (or (lookup base-origins root-id) [0 0])
        origins    (shift-origins base-origins
                                  (- offset-x root-x)
                                  (- offset-y root-y))
        cmp-id     (runtime-id snapshot :variants component-id variant-id)
        file-id    (-> snapshot :runtime :file uuid/parse)]
    (->> nodes
         (map (fn [[_ node]]
                (cond-> (project-node snapshot
                                      components
                                      node-path
                                      #(component-plugin-data component-id
                                                              variant-id
                                                              %)
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

(defn- project-components-page
  "One synthetic page holding the main instance of every Component Set variant.
  Penpot resolves a component through (main-instance-page, main-instance-id),
  so the shapes must live on a real page; this page exists only in the
  projection and is never written back to the Package."
  [snapshot components placements]
  (let [page-id    (-> snapshot :runtime :componentsPage uuid/parse)
        shapes     (reduce (fn [acc placement]
                             (merge acc
                                    (project-variant-shapes snapshot
                                                            components
                                                            placement)))
                           {}
                           placements)
        root-ids   (mapv (fn [{:keys [component-id variant]}]
                           (runtime-id snapshot
                                       :componentNodes
                                       component-id
                                       (:id variant)
                                       (:rootId variant)))
                         placements)
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

(defn- design-system-color-sample
  "First color Cell with a direct hex value, in token-library order. The
  canonical token id is kept: it is the stable source identity. Legacy
  fallback used only when the backend does not provide design-system-refs."
  [snapshot]
  (->> (token-library snapshot)
       :sets
       (mapcat (fn [token-set]
                 (map (fn [token]
                        (assoc token
                               :set-id (:id token-set)
                               :set-name (:name token-set)))
                      (:tokens token-set))))
       (filter (fn [token]
                 (and (= (:type token) "color")
                      (string? (:value token))
                      (str/starts-with? (:value token) "#")
                      (not= (:value token) "#ffffff")
                      (not= (:value token) "#FFFFFF"))))
       (first)))

(defn- design-system-component-sample
  "First variant whose tree contains a real TEXT node, in component-set order."
  [placements]
  (->> placements
       (filter (fn [{:keys [variant]}]
                 (some #(= "TEXT" (:type %)) (vals (:nodes variant)))))
       (first)))

(defn- byte->hex
  [value]
  (let [hex (.toString (js/Math.round (js/Math.min 255 (js/Math.max 0 value))) 16)]
    (if (< (count hex) 2) (str "0" hex) hex)))

(defn- canonical-color->fill
  [value]
  (cond
    (and (string? value) (re-matches #"#[0-9a-fA-F]{8}" value))
    {:fill-color (subs value 0 7)
     :fill-opacity (/ (js/parseInt (subs value 7 9) 16) 255)}

    (and (string? value) (re-matches #"#[0-9a-fA-F]{6}" value))
    {:fill-color value :fill-opacity 1}

    (and (map? value)
         (= "srgb" (some-> (:colorSpace value) str/lower))
         (= 3 (count (:components value))))
    (let [[red green blue] (:components value)]
      {:fill-color (str "#" (byte->hex (* 255 red))
                        (byte->hex (* 255 green))
                        (byte->hex (* 255 blue)))
       :fill-opacity (or (:alpha value) 1)})

    :else nil))

(defn- specimen-rect
  [id name x y width height fill ref]
  (cts/setup-shape
   (cond-> {:id id
            :type :rect
            :name name
            :x x :y y
            :width width :height height
            :parent-id uuid/zero
            :plugin-data
            {:smallpen
             {"design-system" "source"
              "design-system-kind" "token-cell"
              "design-system-ref" (design-system-ref-data ref)}}}
     (some? (canonical-color->fill fill))
     (assoc :fills [(canonical-color->fill fill)]))))

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

(defn- specimen-shadow
  "DTCG shadow Cell -> the native shadow VECTOR the effects panel displays
  and edits. Each record carries the full common Shadow schema (id, style,
  hidden, color attrs) so panel edits re-validated with check-shadow
  succeed, and rgba/hex colors round-trip without going black or losing
  alpha."
  [value]
  (let [color (css-color->attrs (:color value))]
    (when-not color
      (throw (ex-info "unsupported SmallPen shadow color"
                      {:type :validation
                       :code :unsupported-smallpen-shadow-color
                       :color (:color value)})))
    [{:id nil
      :style :drop-shadow
      :hidden false
      :blur (or (:blur value) 0)
      :offset-x (or (:offsetX value) (:offset-x value) 0)
      :offset-y (or (:offsetY value) (:offset-y value) 0)
      :spread (or (:spread value) 0)
      :color color}]))

(defn- specimen-name
  ([ref]
   (str "Token / " (:setName ref) "/" (:path ref)))
  ([ref combo-label]
   (if combo-label
     (str "Token / " (:setName ref) "/" (:path ref) " · " combo-label)
     (str "Token / " (:setName ref) "/" (:path ref)))))

(defn- token-value-label
  [value]
  (if (map? value)
    (->> value
         (sort-by (comp name key))
         (map (fn [[key item]] (str (name key) "=" item)))
         (str/join ", "))
    (str value)))

(defn- token-caption
  [ref]
  (str (:ownerPackageId ref) " · " (:setName ref) " · " (:type ref)
       "\n" (:path ref) " = " (token-value-label (:raw ref))
       " · " (if (:alias ref) "alias" "literal")
       " · " (or (:status ref) "active")))

(defn- board-text-metrics
  [text size]
  (let [lines (str/split (str text) "\n")]
    {:width (max 80 (* size (apply max 0 (map (fn [line]
                                                              (reduce + 0 (map #(if (> (.charCodeAt % 0) 255) 1 0.62) line)))
                                                            lines))))
     :height (max 18 (* 1.4 size (max 1 (count lines))))}))

(defn- transparent-color?
  [value]
  (zero? (or (:fill-opacity (canonical-color->fill value)) 1)))

(defn- white-color?
  [value]
  (= "#ffffff" (some-> (:fill-color (canonical-color->fill value)) str/lower)))

(defn- decorate-color-specimen
  [shape value]
  (cond-> shape
    (or (white-color? value) (transparent-color? value))
    (assoc :strokes [{:stroke-color "#64748b"
                      :stroke-opacity 1
                      :stroke-style (if (transparent-color? value) :dashed :solid)
                      :stroke-width 1
                      :stroke-alignment :inner}])

    (transparent-color? value)
    (assoc :fills [(canonical-color->fill value)])))

(defn- typography-specimen
  [snapshot id name x y width value ref]
  (let [font-size   (or (:fontSize value) 16)
        line-height (or (:lineHeight value) 1.2)]
    (cts/setup-shape
     {:id id
      :type :text
      :name name
      :x x :y y
      :width width
      :height (max 48 (* font-size line-height))
      :grow-type :fixed
      :parent-id uuid/zero
      :content (project-text-content
                snapshot
                "Ag Typography"
                [{:color "#111827" :type "solid"}]
                value
                nil)
      :plugin-data
      {:smallpen
       {"design-system" "source"
        "design-system-kind" "token-cell"
        "design-system-ref" (design-system-ref-data ref)}}})))

(defn- specimen-child-rect
  "Gap-specimen filler built at its FINAL position (DSE-R08): the frame's
  position is known before the child is constructed so setup-shape derives a
  consistent selrect/points."
  [id x y]
  (cts/setup-shape
   {:id id
    :type :rect
    :name "Specimen filler"
    :x x :y y
    :width 24 :height 24
    :parent-id uuid/zero
    :fills [{:fill-color "#c7d2fe" :fill-opacity 1}]
    :plugin-data
    {:smallpen {"design-system" "decoration"}}}))

(def ^:private specimen-cell-height 48)

(declare board-text)

(defn- specimen-item
  "Layout unit for one Token Cell display (DSE-011-B, DSE-R10): metrics plus
  a builder that constructs the native shapes AT the requested board
  position. Shapes are never moved after setup-shape (DSE-R08). Literal
  Cells of supported types are editable write targets; alias Cells,
  typography Cells and unknown types render as displays whose direct edits
  fail with design_system_token_readonly. Gap frames carry the runtime child
  ids of their filler rects."
  [snapshot ref]
  (let [{:keys [attribute shape value writable alias type]} ref
        shape-id (uuid/parse shape)
        caption  (some-> (:caption ref) uuid/parse)
        display
        (fn [width height fill]
          {:key (:path ref) :order (:order ref) :width width :height height
           :build (fn [x y] [(specimen-rect shape-id (specimen-name ref) x y width height fill ref)])})
        sample
        (cond
          (= type "typography")
          {:key (:path ref) :order (:order ref) :width 220
           :height (max specimen-cell-height
                        (* (or (:fontSize value) 16)
                           (or (:lineHeight value) 1.2)))
           :build (fn [x y]
                    [(typography-specimen snapshot shape-id (specimen-name ref)
                                          x y 220 value ref)])}

          alias
          (display 120 specimen-cell-height "#fef3c7")

          (nil? attribute)
          (display 120 specimen-cell-height "#fee2e2")

          (= attribute "fill")
          {:key (:path ref) :order (:order ref) :width 96 :height specimen-cell-height
           :build (fn [x y]
                    [(decorate-color-specimen
                      (specimen-rect shape-id (specimen-name ref) x y 96 48 value ref)
                      value)])}

          (= attribute "radius")
          {:key (:path ref) :order (:order ref) :width 96 :height specimen-cell-height
           :build (fn [x y]
                    [(assoc (specimen-rect shape-id (specimen-name ref) x y 96 48 "#eef2ff" ref)
                            :r1 value :r2 value :r3 value :r4 value)])}

          (= attribute "height")
          (let [visual-height (max 8 (min 160 value))]
            {:key (:path ref) :order (:order ref) :width 96 :height visual-height
             :build (fn [x y]
                      [(specimen-rect shape-id (specimen-name ref) x y 96 visual-height "#eef2ff" ref)])})

          (= attribute "gap")
          {:key (:path ref) :order (:order ref) :width 120 :height specimen-cell-height
           :build (fn [x y]
                    [(cts/setup-shape
                      {:id shape-id
                       :type :frame
                       :name (specimen-name ref)
                       :x x :y y
                       :width 120 :height 48
                       :layout :flex
                       :layout-flex-dir :row
                       :layout-gap-type :fixed
                       :layout-gap {:rowGap value :columnGap value}
                       :parent-id uuid/zero
                       :fills [{:fill-color "#eef2ff" :fill-opacity 1}]
                       :shapes (mapv #(uuid/parse %) (:children ref))
                       :plugin-data
                       {:smallpen
                        {"design-system" "source"
                         "design-system-kind" "token-cell"
                         "design-system-ref" (design-system-ref-data ref)}}})
                     (specimen-child-rect (uuid/parse (first (:children ref))) (+ x 8) (+ y 12))
                     (specimen-child-rect (uuid/parse (second (:children ref))) (+ x 40) (+ y 12))])}

          (= attribute "stroke-width")
          {:key (:path ref) :order (:order ref) :width 96 :height specimen-cell-height
           :build (fn [x y]
                    [(-> (specimen-rect shape-id (specimen-name ref) x y 96 48 "#ffffff" ref)
                         (assoc :strokes
                                [{:stroke-color "#111827"
                                  :stroke-opacity 1
                                  :stroke-style :solid
                                  :stroke-width value
                                  :stroke-alignment :inner}]))])}

          (= attribute "shadow")
          {:key (:path ref) :order (:order ref) :width 96 :height specimen-cell-height
           :build (fn [x y]
                    [(assoc (specimen-rect shape-id (specimen-name ref) x y 96 48 "#ffffff" ref)
                            :shadow (specimen-shadow value))])}

          :else (display 120 specimen-cell-height "#fee2e2"))]
    (if-not caption
      sample
      (let [caption-text  (token-caption ref)
            caption-width (max 180 (:width (board-text-metrics caption-text 11)))
            sample-y      38]
        (assoc sample
               :width (max caption-width (:width sample))
               :height (+ sample-y (:height sample))
               :build (fn [x y]
                        (into [(board-text snapshot caption caption-text x y
                                           {:size 11 :opacity (if (= "archived" (:status ref)) 0.5 0.8)})]
                              ((:build sample) x (+ y sample-y)))))))))

(defn- specimen-items
  "One layout unit per Token Cell display, in the backend's stable catalog
  order (DSE-R10: every Cell, no per-type sampling)."
  [snapshot refs content-width]
  (let [specimens (sort-by :order (vals (:specimens refs)))
        groups    (:tokenGroups refs)]
    (if (seq groups)
      (->> groups
           (mapcat
            (fn [{:keys [header ownerPackageId setId setName type]}]
              (let [members (filter #(and (= ownerPackageId (:ownerPackageId %))
                                          (= setId (:setId %))
                                          (= type (:type %)))
                                    specimens)]
                (into [{:key (str "token-group:" ownerPackageId "/" setId "/" type)
                        :width content-width
                        :height 24
                        :build (fn [x y]
                                 [(board-text snapshot (uuid/parse header)
                                              (str ownerPackageId " / " setName " / " type)
                                              x y {:size 13 :opacity 0.7})])}]
                      (keep #(specimen-item snapshot %) members)))))
           (vec))
      (->> specimens
           (keep #(specimen-item snapshot %))
           (vec)))))

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
  (let [nodes      (:nodes (screen-presentation snapshot screen-id presentation-id))
        tree       (subtree-nodes nodes main-node-id)
        parents    (parent-index tree)
        node-path  [:nodes screen-id presentation-id]
        base-origins (absolute-origins tree [main-node-id])
        [root-x root-y] (or (lookup base-origins main-node-id) [0 0])
        cmp-id     (runtime-id snapshot :components component-id)
        file-id    (-> snapshot :runtime :file uuid/parse)]
    (fn [offset-x offset-y]
      (let [origins (shift-origins base-origins
                                   (- offset-x root-x)
                                   (- offset-y root-y))]
        (->> (vals tree)
             (map (fn [node]
                    (cond->
                     (project-node snapshot
                                   components
                                   node-path
                                   #(screen-plugin-data screen-id presentation-id %)
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

(def ^:private board-caption-height 28)

(defn- board-text
  "Decoration text shape built at its final position. The LAYER name is
  prefixed so caption rows never collide with the component roots they
  introduce. grow-type stays :fixed with a conservative pre-measured width:
  auto-width texts make the renderer fire measure/resize follow-ups that
  pollute the user's undo history on generated pages (DSE-R11)."
  [snapshot id text x y {:keys [size opacity plain-name?]
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
      :fontWeight (if (= size 20) 600 400)}
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

(defn- empty-state-item
  [snapshot id text]
  {:key (str "empty:" text)
   :width 240
   :height 28
   :build (fn [x y]
            [(board-text snapshot id text x y {:size 13 :opacity 0.55})])})

;; --- DSE-R17~R26: the fully-expanded Design Token panorama -----------------
;;
;; Simple white type cards contain every source-backed specimen. Combination
;; groups remain fully expanded inside each card. Shells, rulers and labels
;; are presentation-only; no generated page is persisted.

(def ^:private canonical-token-types
  "The 20 canonical Token types, with visual foundations first."
  ["color" "border-radius" "spacing" "sizing" "dimensions" "typography"
   "font-family" "font-size" "font-weight" "letter-spacing" "text-case"
   "text-decoration" "stroke-width" "shadow" "opacity" "rotation"
   "number" "boolean" "string" "other"])

(def ^:private displayed-token-types
  ;; Font primitives remain real Tokens in the library/inspector. The sheet
  ;; shows complete Typography styles instead of six separate font sections.
  (vec (remove #{"font-family" "font-size" "font-weight" "letter-spacing"
                 "text-case" "text-decoration"}
               canonical-token-types)))

(defn- token-display-value
  "The value a specimen shows: the alias-resolved value when the reference
  chain resolves, otherwise the raw literal (the unresolved diagnosis stays
  visible in the caption)."
  [ref]
  (if (and (:alias ref) (not (:unresolvedAlias ref)) (not (:aliasCycle ref)))
    (:resolved ref)
    (:raw ref)))

(defn- token-json
  [value]
  (js/JSON.stringify (clj->js value)))

(defn- token-human-value
  "Human-readable value for the canvas caption (R18: semantic name, visual
  sample, human value — never owner/path/status/internal metadata)."
  [type value]
  (cond
    (nil? value) "—"
    (and (map? value) (= type "shadow"))
    (str (or (get value :offsetX) (get value "offsetX") 0)
         " " (or (get value :offsetY) (get value "offsetY") 0)
         " · blur " (or (get value :blur) (get value "blur") 0)
         " · spread " (or (get value :spread) (get value "spread") 0))
    (and (map? value) (= type "typography"))
    (let [getv (fn [k] (or (get value k) (get value (name k))))]
      (str (or (getv :fontFamily) "?") " · "
           (or (getv :fontSize) "?") "/" (or (getv :lineHeight) "?")
           " · " (or (getv :fontWeight) "?")))
    (map? value) (token-json value)
    (= type "opacity") (str (js/Math.round (* 100 (js/Number value))) "%")
    (= type "rotation") (str value "°")
    :else (str value)))

(defn- clean-token-caption
  "One clean caption line: `semantic-name = human value` plus, only for
  broken alias chains, the semantic diagnosis. Alias EXPRESSIONS and
  owner/set/status metadata live in the selection panel, not on the canvas."
  [ref]
  (let [value (token-display-value ref)
        shown (if (= (:type ref) "other")
                (let [s (token-human-value "other" value)]
                  (if (> (count s) 64) (str (subs s 0 64) "…") s))
                (token-human-value (:type ref) value))]
    (str (:path ref) " = " shown
         (cond
           (:aliasCycle ref) "（引用成环）"
           (:unresolvedAlias ref) "（引用未解析）"
           :else ""))))

(defn- clamped
  [value low high]
  (js/Math.max low (js/Math.min high (js/Number value))))

(defn- decoration-id
  "Fresh id for a micro-decoration (checker cells, rulers, card shells).
  Decorations are rebuilt on every re-projection and are never canonical, so
  unlike specimen ids these do not need cross-rebuild stability."
  []
  (uuid/next))

(defn- parsed-decoration-id
  "Runtime decoration ids arrive as JSON strings and MUST enter the store as
  uuid objects: a string id poisons every later renderer sync for the shape
  (schema check fails -> 'Something wrong has happened' toast at mount).
  Missing ids (older backend refs) fall back to a fresh decoration uuid."
  [value]
  (or (some-> value uuid/parse) (decoration-id)))

(defn- decoration-rect
  [id x y width height fill]
  (cts/setup-shape
   {:id id :type :rect :name "Board decoration"
    :x x :y y :width width :height height
    :parent-id uuid/zero
    :fills (if (some? fill) [{:fill-color fill :fill-opacity 1}] [])
    :plugin-data {:smallpen {"design-system" "decoration"}}}))

(defn- ruler-shapes
  "Decoration ruler (line + end ticks) measuring `length` px from (x y) in
  direction :horizontal or :vertical (DSE-R21: real geometry with a ruler)."
  [x y length direction]
  (let [tick 8
        thin 1
        mk   (fn [rx ry w h] (decoration-rect (decoration-id) rx ry w h "#94a3b8"))]
    (if (= direction :vertical)
      [(mk x y thin length)
       (mk (- x (/ tick 2) (/ thin 2)) y tick thin)
       (mk (- x (/ tick 2) (/ thin 2)) (+ y length (- thin)) tick thin)]
      [(mk x y length thin)
       (mk x (- y (/ tick 2) (/ thin 2)) thin tick)
       (mk (+ x length (- thin)) (- y (/ tick 2) (/ thin 2)) thin tick)])))

(defn- checker-frame
  "Decoration checkerboard backdrop under white/transparent/opacity
  specimens (DSE-R19/R23)."
  [x y width height]
  (let [cell 16
        cols (js/Math.ceil (/ width cell))
        rows (js/Math.ceil (/ height cell))
        frame-id (decoration-id)
        cells
        (for [row (range rows) col (range cols)]
          (let [id (decoration-id)]
            {:id id
             :shape (decoration-rect id
                                     (+ x (* col cell)) (+ y (* row cell))
                                     cell cell
                                     (if (even? (mod (+ row col) 2)) "#e2e8f0" "#ffffff"))}))]
    (into
     [(cts/setup-shape
       {:id frame-id :type :frame :name "Board decoration"
        :x x :y y :width width :height height
        :parent-id uuid/zero
        :fills []
        :shapes (mapv :id cells)
        :plugin-data {:smallpen {"design-system" "decoration"}}})]
     (mapv :shape cells))))

(defn- specimen-text-shape
  "Source-mapped TEXT shape (value cards and font specimens): the token-cell
  target, styled by `style`. Fixed width with a conservatively pre-measured
  height (same rationale as board-text, DSE-R11)."
  [snapshot id text x y width style ref combo-label]
  (let [size  (or (:fontSize style) 14)
        lines (js/Math.max 1 (count (str/split (str text) "\n")))]
    (cts/setup-shape
     {:id id
      :type :text
      :name (specimen-name ref combo-label)
      :x x :y y
      :width width
      :height (js/Math.max 24 (* 1.45 size lines))
      :grow-type :fixed
      :parent-id uuid/zero
      :content
      (project-text-content
       snapshot
       (str text)
       [{:color "#111827" :type "solid"}]
       (merge {:fontFamily "Inter"
               :fontId "gfont-inter"
               :fontSize 14
               :fontVariantId "regular"
               :fontWeight 400
               :letterSpacing 0
               :lineHeight 1.45
               :textTransform "none"
               :textDecoration "none"}
              style)
       nil)
      :plugin-data
      {:smallpen
       {"design-system" "source"
        "design-system-kind" "token-cell"
        "design-system-ref" (design-system-ref-data ref)}}})))

(defn- scalar-card-text
  "The literal text shown on a scalar value card: the RAW Cell value (what a
  text edit writes back), never the alias-resolved display value."
  [ref]
  (let [raw (:raw ref)]
    (cond
      (string? raw) raw
      (map? raw) (token-json raw)
      :else (str raw))))

(def ^:private specimen-visual-width 200)

(defn- panorama-specimen-item
  "Layout unit for one (Cell × combination) specimen on the panorama: clean
  caption + the type's real visual, built at final position (DSE-R08).
  combo-label disambiguates the LAYER name (two combinations showing the
  same Cell produce two rows in the layers tree). Returns
  {:key :width :height :build}."
  [snapshot ref combo-label]
  (let [{:keys [attribute shape value type]} ref
        shape-id   (uuid/parse shape)
        display    (token-display-value ref)
        caption    (clean-token-caption ref)
        metrics    (board-text-metrics caption 12)
        card       (fn [build-height build-fn]
                     {:key (:shape ref) :width (max specimen-visual-width (:width metrics))
                      :height (+ 12 build-height (:height metrics))
                      :build (fn [x y]
                               (conj (vec (build-fn x y))
                                     (board-text snapshot (uuid/parse (:caption ref))
                                                 caption x (+ y build-height 12)
                                                 {:size 12 :opacity 0.75})))})
        visual
        (case (or attribute type)
          "fill"
          (let [fill (canonical-color->fill display)]
            (card 48
                  (fn [x y]
                    (let [swatch (decorate-color-specimen
                                  (specimen-rect shape-id (specimen-name ref combo-label) x y 96 48 display ref)
                                  display)]
                      (if (or (white-color? display) (transparent-color? display)
                              (and (some? fill) (< (or (:fill-opacity fill) 1) 1)))
                        (into (checker-frame x y 96 48) [swatch])
                        [swatch])))))

          "radius"
          (card 48
                (fn [x y]
                  [(-> (specimen-rect shape-id (specimen-name ref combo-label) x y 96 48 "#eef2ff" ref)
                       (assoc :r1 display :r2 display :r3 display :r4 display))]))

          "height"
          (let [vh (clamped display 8 160)]
            (card (+ vh 12)
                  (fn [x y]
                    (into [(specimen-rect shape-id (specimen-name ref combo-label) (+ x 16) y 96 vh "#eef2ff" ref)]
                          (ruler-shapes x y vh :vertical)))))

          "gap"
          (card 64
                (fn [x y]
                  (into
                   [(cts/setup-shape
                     {:id shape-id
                      :type :frame
                      :name (specimen-name ref combo-label)
                      :x x :y y
                      :width 120 :height 48
                      :layout :flex
                      :layout-flex-dir :row
                      :layout-gap-type :fixed
                      :layout-gap {:rowGap display :columnGap display}
                      :layout-padding-type :multiple
                      :layout-padding {:p1 12 :p2 8 :p3 12 :p4 8}
                      :parent-id uuid/zero
                      :fills [{:fill-color "#eef2ff" :fill-opacity 1}]
                      :shapes (mapv #(uuid/parse %) (:children ref))
                      :plugin-data
                      {:smallpen
                       {"design-system" "source"
                        "design-system-kind" "token-cell"
                        "design-system-ref" (design-system-ref-data ref)}}})
                    (specimen-child-rect (uuid/parse (first (:children ref))) (+ x 8) (+ y 12))
                    ;; child2 sits one gap after child1 (8 + 24 + gap), the
                    ;; same spot the flex layout assigns at render time.
                    (specimen-child-rect (uuid/parse (second (:children ref))) (+ x 32 (js/Number display)) (+ y 12))]
                   (ruler-shapes (+ x 32) (+ y 52) (js/Number display) :horizontal))))

          "stroke-width"
          (card 48
                (fn [x y]
                  [(-> (specimen-rect shape-id (specimen-name ref combo-label) x y 96 48 "#ffffff" ref)
                       (assoc :strokes
                              [{:stroke-color "#111827"
                                :stroke-opacity 1
                                :stroke-style :solid
                                :stroke-width (js/Number display)
                                :stroke-alignment :inner}]))]))

          "shadow"
          (card 64
                (fn [x y]
                  [(assoc (specimen-rect shape-id (specimen-name ref combo-label) x (+ y 8) 96 48 "#ffffff" ref)
                          :shadow (specimen-shadow display))]))

          "opacity"
          (card 48
                (fn [x y]
                  (let [fg (-> (specimen-rect shape-id (specimen-name ref combo-label) x y 96 48 nil ref)
                               (assoc :fills [{:fill-color "#6750a4" :fill-opacity 1}]
                                      :opacity (js/Number display)))]
                    (into (checker-frame x y 96 48) [fg]))))

          "rotation"
          (card 88
                (fn [x y]
                  (let [w 88 h 36
                        cx (+ x (/ w 2)) cy (+ y (/ h 2))
                        angle (js/Number display)
                        rot   (mod (+ (mod angle 360) 360) 360)]
                    [(-> (specimen-rect shape-id (specimen-name ref combo-label) x y w h "#eef2ff" ref)
                         (assoc :rotation rot
                                :transform (if (zero? rot)
                                             (gmt/matrix)
                                             (gmt/rotate-matrix rot (gpt/point cx cy)))))
                     (decoration-rect (decoration-id)
                                      (+ x -7) (+ cy -4) 8 8 "#6750a4")])))

          "dimensions"
          (let [side (clamped display 8 160)]
            (card (+ side 14)
                  (fn [x y]
                    (into [(specimen-rect shape-id (specimen-name ref combo-label) x y side side "#eef2ff" ref)]
                          (ruler-shapes x (+ y side 3) side :horizontal)))))

          "font-family"
          (card 32
                (fn [x y]
                  [(specimen-text-shape snapshot shape-id "Ag 字形 Aa 123" x y specimen-visual-width
                                        {:fontFamily (str display) :fontSize 18} ref combo-label)]))

          "font-size"
          (let [size (clamped display 8 96)]
            (card (* size 1.5)
                  (fn [x y]
                    [(specimen-text-shape snapshot shape-id "Ag" x y specimen-visual-width
                                          {:fontSize size :lineHeight 1.4} ref combo-label)])))

          "font-weight"
          (card 32
                (fn [x y]
                  [(specimen-text-shape snapshot shape-id "Ag 字重" x y specimen-visual-width
                                        {:fontWeight (js/Number display) :fontVariantId (str display)} ref combo-label)]))

          "letter-spacing"
          (card 32
                (fn [x y]
                  [(specimen-text-shape snapshot shape-id "Spacing 间距" x y specimen-visual-width
                                        {:letterSpacing (js/Number display)} ref combo-label)]))

          "text-transform"
          (card 32
                (fn [x y]
                  [(specimen-text-shape snapshot shape-id "Ag Case 文字" x y specimen-visual-width
                                        {:textTransform (case (str display)
                                                          "title-case" "capitalize"
                                                          (str display))} ref combo-label)]))

          "text-decoration"
          (card 32
                (fn [x y]
                  [(specimen-text-shape snapshot shape-id "Ag Link 文字" x y specimen-visual-width
                                        {:textDecoration (str display)} ref combo-label)]))

          "typography"
          (assoc (card (max 48 (* (or (:fontSize display) 16) (or (:lineHeight display) 1.2)))
                       (fn [x y]
                         [(typography-specimen snapshot shape-id (specimen-name ref combo-label)
                                               x y 220 display ref)]))
                 :width (max 220 (:width metrics)))

          ;; Scalar and semantic types (boolean/number/string/other) render
          ;; as value cards: a decoration card shell with the RAW value as a
          ;; source-mapped, text-editable shape (DSE-R24).
          (let [text  (scalar-card-text ref)
                lines (js/Math.max 1 (js/Math.ceil (/ (count text) 26)))
                h     (js/Math.max 30 (* 18 lines))]
            (card (+ h 10)
                  (fn [x y]
                    [(decoration-rect (decoration-id)
                                      x y specimen-visual-width (+ h 10) "#f8fafc")
                     (specimen-text-shape snapshot shape-id text (+ x 8) (+ y 5)
                                          (- specimen-visual-width 16)
                                          {:fontSize 14 :lineHeight 1.3} ref combo-label)]))))]
    visual))

(defn- component-sample-shapes
  [snapshot components family x y]
  (let [sample-snapshot (assoc-in snapshot [:runtime :componentNodes
                                           (keyword (:componentSetId family))
                                           (keyword (:variantId family))]
                                  (:runtimeNodes family))]
    (if (:error family)
      [(board-text snapshot (decoration-id) (:error family) x y {:size 14})]
      (map (fn [shape]
             (let [node-id (some (fn [[id runtime-id]]
                                   (when (= (:id shape) (uuid/parse runtime-id)) (name id)))
                                 (:runtimeNodes family))
                   ref     (lookup (:sources family) node-id)]
               (mark-design-system-source
                (dissoc shape :component-id :component-file :component-root :main-instance :shape-ref)
                (assoc ref :kind "component-definition" :sourceNodeId (:nodeId ref)))))
           (vals (project-variant-shapes
                  sample-snapshot components
                  {:component-id (:componentSetId family)
                   :variant {:id (:variantId family) :rootId (:rootId family) :nodes (:nodes family)}
                   :offset-x x :offset-y y}))))))

(defn- component-sample-item
  [snapshot components family]
  (let [nodes (:nodes family)
        [w h] (subtree-size nodes (:rootId family))
        label (str (:label family) " · " (:combinationLabel family))
        width (max 280 (+ w 32) (:width (board-text-metrics label 13)))]
    {:width (+ width 32)
     :height (+ 72 (max h 48))
     :build (fn [x y]
              (into [(assoc (decoration-rect (decoration-id) x y (+ width 32)
                                              (+ 72 (max h 48)) "#f1f5f9")
                            :name (str "Component sample · " label))
                     (board-text snapshot (uuid/parse (:caption family)) label
                                 (+ x 16) (+ y 16) {:size 13 :plain-name? true})]
                    (component-sample-shapes snapshot components family (+ x 16) (+ y 48))))}))

(defn- dimension-label
  [value]
  (get {"Style" "样式" "Content" "图文排列" "State" "状态" "Theme" "主题"
        "Tone" "语义" "Level" "层级" "Kind" "类型"
        "primary" "主要" "secondary" "次要" "ghost" "透明"
        "text" "纯文字" "leading" "左侧图标" "trailing" "右侧图标" "icon" "仅图标"
        "default" "默认" "idle" "默认" "hover" "悬停" "pressed" "按下" "disabled" "禁用"
        "Light" "浅色" "Dark" "深色" "neutral" "中性" "success" "成功" "danger" "警示"
        "focus" "聚焦" "error" "错误" "page" "页面标题" "section" "区块标题"
        "dialog" "弹窗标题" "confirm" "确认" "form" "表单"}
       value (str value)))

(defn- dimension-value
  [sample dimension]
  (if (= ::theme (:id dimension))
    (or (:combinationId sample) (:combinationLabel sample) "Default")
    (when dimension (lookup (:selection sample) (:id dimension)))))

(defn- dimension-text
  [dimension value]
  (dimension-label (get (:labels dimension) value value)))

(defn- balanced-flow
  "Choose a row wrap from actual item sizes, minimizing the longest side.
  This balances both wide matrices and tall composite previews."
  [items y]
  (let [w (apply max 1 (map :width items))
        candidates (map (fn [columns]
                          (let [width (+ (* columns w) (* 32 (dec columns)))
                                flow  (flow-layout items 0 y width 32 32)]
                            (assoc flow :width width)))
                        (range 1 (inc (count items))))]
    (apply min-key #(max (:width %) (:end-y %)) candidates)))

(defn- component-matrix-panel
  [snapshot components samples column row column-values row-values title]
  (let [sizes       (map #(subtree-size (:nodes %) (:rootId %)) samples)
        cell-width  (max (+ 40 (apply max 0 (map first sizes)))
                         (apply max 120 (map #(+ 32 (:width (board-text-metrics (dimension-text column %) 16))) column-values)))
        slots       (group-by #(vector (dimension-value % column) (dimension-value % row)) samples)
        item-height (+ 32 (apply max 48 (map second sizes)))
        cell-height (* item-height (apply max 1 (map count (vals slots))))
        gutter      (apply max 112 (map #(+ 32 (:width (board-text-metrics (dimension-text row %) 16))) row-values))
        width       (max (+ 48 (:width (board-text-metrics title 18)))
                         (+ 48 gutter (* cell-width (count column-values))))
        height      (+ 128 (* cell-height (count row-values)))]
    {:width width :height height
     :build
     (fn [x y]
       (into [(assoc (decoration-rect (decoration-id) x y width height "#ffffff")
                     :name (str "Component matrix · " title))
              (board-text snapshot (decoration-id) title (+ x 24) (+ y 20) {:size 18 :plain-name? true})
              (board-text snapshot (decoration-id)
                          (str (dimension-label (:name row)) " / " (dimension-label (:name column)))
                          (+ x 24) (+ y 64) {:size 14 :opacity 0.65 :plain-name? true})]
             (concat
              (map-indexed (fn [i value]
                             (board-text snapshot (decoration-id) (dimension-text column value)
                                         (+ x 24 gutter (* i cell-width)) (+ y 64) {:size 16 :plain-name? true}))
                           column-values)
              (mapcat
               (fn [[j row-value]]
                 (let [ry (+ y 104 (* j cell-height))]
                   (into [(decoration-rect (decoration-id) (+ x 16) ry (- width 32) cell-height
                                            (if (even? j) "#f6f7f9" "#ffffff"))
                          (board-text snapshot (decoration-id) (dimension-text row row-value)
                                      (+ x 24) (+ ry 16) {:size 16 :plain-name? true})]
                         (mapcat
                          (fn [[i column-value]]
                            (let [members (get slots [column-value row-value])
                                  cx      (+ x 24 gutter (* i cell-width))]
                              (if (seq members)
                                (mapcat (fn [[n sample]]
                                          (component-sample-shapes snapshot components sample cx (+ ry 16 (* n item-height))))
                                        (map-indexed vector members))
                                [(board-text snapshot (decoration-id) "—" cx (+ ry 16) {:size 16 :opacity 0.4})])))
                          (map-indexed vector column-values)))))
               (map-indexed vector row-values)))))}))

(defn- component-family-matrix
  [snapshot components samples]
  (let [theme      {:id ::theme :name "Theme"
                    :labels (into {} (map #(vector (or (:combinationId %) (:combinationLabel %) "Default")
                                                   (:combinationLabel %)) samples))}
        dimensions (mapv (fn [axis]
                           (let [observed (vec (distinct (map #(dimension-value % axis) samples)))
                                 ordered  (filter (set observed) (:domain axis))]
                             (assoc axis :values (vec (concat ordered (remove (set ordered) observed))))))
                         (conj (vec (:axes (first samples))) theme))
        varying    (filter #(> (count (:values %)) 1) dimensions)
        axes       (sort-by #(- (count (:values %))) (remove #(= ::theme (:id %)) varying))
        row        (or (some #(when (= "state" (:role %)) %) axes)
                       (some #(when (= ::theme (:id %)) %) varying)
                       (second axes))
        column     (or (first (remove #(= (:id row) (:id %)) axes))
                       (first (remove #(= (:id row) (:id %)) varying)))
        facets     (remove #(contains? #{(:id row) (:id column)} (:id %)) dimensions)
        groups     (group-by #(mapv (partial dimension-value %) facets) samples)
        keys       (distinct (map #(mapv (partial dimension-value %) facets) samples))
        panels     (vec
                    (mapcat
                     (fn [key]
                       (let [group (get groups key)
                             title (str/join " · " (map #(str (dimension-label (:name %1)) "：" (dimension-text %1 %2)) facets key))]
                         (for [rows (partition-all 6 (or (:values row) [nil]))
                               cols (partition-all 6 (or (:values column) [nil]))]
                           (component-matrix-panel snapshot components
                                                   (filter #(and (contains? (set rows) (dimension-value % row))
                                                                 (contains? (set cols) (dimension-value % column))) group)
                                                   column row (vec cols) (vec rows)
                                                   (if (seq title) title (:familyName (first samples)))))))
                     keys))
        flow       (balanced-flow panels 64)
        title      (str (:familyName (first samples)) " · " (count samples) " 个展示组合")]
    {:width (:width flow) :height (:end-y flow)
     :build (fn [x y]
              (into [(board-text snapshot (decoration-id) title x y {:size 20 :plain-name? true})]
                    (mapcat (fn [panel [px py]] ((:build panel) (+ x px) (+ y py))) panels (:positions flow))))}))

(defn- family-item
  "Layout unit for one component family entry: caption label + the full
  native tree of the variant or located component definition."
  [snapshot components placements family]
  (when-let [{:keys [root-id build ref]} (project-family-tree
                                          snapshot
                                          components
                                          placements
                                          family)]
    (let [[tree-width tree-height] (if (= "located" (:kind family))
                                     (let [nodes (:nodes (screen-presentation
                                                          snapshot
                                                          (:screenId family)
                                                          (:presentationId family)))
                                           [w h] (subtree-size (subtree-nodes nodes (:mainNodeId family))
                                                               (:mainNodeId family))]
                                       [w h])
                                     (let [nodes (some (fn [{:keys [component-id variant]}]
                                                         (when (and (= (:componentSetId family) component-id)
                                                                    (= (:variantId family) (:id variant)))
                                                           (:nodes variant)))
                                                       placements)]
                                       (subtree-size nodes (:rootId family))))]
      {:key (str (:kind family) ":" (or (:componentSetId family)
                                        (:componentId family))
                 "/" (or (:variantId family) "main"))
       :width (max tree-width
                   200
                   (:width (board-text-metrics (or (:label family) "Component") 13)))
       :height (+ board-caption-height (max tree-height 48))
       :build
       (fn [x y]
         (into [(board-text snapshot (uuid/parse (:caption family))
                            (or (:label family) "Component")
                            x y {:size 13 :opacity 0.75})]
               (mapv (fn [shape]
                       (mark-design-system-source shape ref))
                     (build x (+ y board-caption-height)))))})))


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
                        :fills [{:fill-color "#fafafa" :fill-opacity 1}]
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

(defn- token-type-card
  "A white type section with every valid combination visible in local groups.
  Only basic source-backed specimens and presentation-only labels are drawn."
  [snapshot refs type specimens]
  (let [members (filter #(= type (:type %)) specimens)
        groups  (cond-> (mapv #(select-keys % [:id :label]) (:combinations refs))
                  (some #(nil? (:combinationId %)) members)
                  (conj {:id nil :label "Archived · 未激活"}))
        groups  (keep (fn [group]
                        (let [items (vec (keep #(panorama-specimen-item snapshot % (:label group))
                                               (sort-by :order
                                                        (filter #(= (:id group) (:combinationId %))
                                                                members))))]
                          (when (seq items) (assoc group :items items))))
                      groups)
        width   (max 680 (apply max 0 (mapcat #(map :width (:items %)) groups)))
        content (loop [remaining groups
                       y         68
                       plans     []]
                  (if-let [{:keys [id label items]} (first remaining)]
                    (let [flow (flow-layout items 24 (+ y 30) width 28 24)]
                      (recur (rest remaining) (+ (:end-y flow) 32)
                             (conj plans {:label (if id label "其他 Token")
                                          :y y :items items :positions (:positions flow)})))
                    {:plans plans :height (max 124 y)}))
        cells   (count (set (map (juxt :ownerPackageId :setId :tokenId) members)))
        title   (str type " · " cells)
        id      (parsed-decoration-id (lookup (get-in snapshot [:runtime :designSystem :types]) type))]
    {:width (+ width 48)
     :height (:height content)
     :build (fn [x y]
              ;; Build at final coordinates, including rotated specimens.
              (into [(assoc (decoration-rect (decoration-id) x y
                                              (+ width 48) (:height content) "#ffffff")
                            :name (str "Token type · " type))
                     (board-text snapshot id title (+ x 24) (+ y 24)
                                 {:size 20 :plain-name? true})]
                    (if (seq members)
                      (mapcat (fn [{:keys [label items positions] group-y :y}]
                                (into [(board-text snapshot (decoration-id) label
                                                   (+ x 24) (+ y group-y)
                                                   {:size 13 :opacity 0.6 :plain-name? true})]
                                      (mapcat (fn [item [ix iy]] ((:build item) (+ x ix) (+ y iy)))
                                              items positions)))
                              (:plans content))
                      [(board-text snapshot (decoration-id) "暂无 Token"
                                   (+ x 24) (+ y 68) {:size 13 :opacity 0.5})])))}))

(defn- project-panorama-shapes
  "Fully expanded type cards and a separate Components zone.
  Combination groups are local to each card, never global comparison columns."
  [snapshot placements refs]
  (let [pad           40
        zone-gap      140
        tokens-top    (+ pad 92)
        specimens     (vals (:specimens refs))
        cards         (mapv #(token-type-card snapshot refs % specimens) displayed-token-types)
        token-flow    (flow-layout cards pad tokens-top 1496 32 32)
        tokens-shapes (mapcat (fn [card [x y]] ((:build card) x y))
                              cards (:positions token-flow))
        tokens-end-y  (:end-y token-flow)
        tokens-right  (:max-x token-flow)
        components    (component-index snapshot)
        content-width 640
        components-x  (+ tokens-right zone-gap)
        family-items  (let [samples (:componentSamples refs)
                           groups (partition-by :componentSetId
                                                (sort-by (juxt #(if (= "Primitive" (:classification %)) 0 1)
                                                               :componentSetId :variantIndex :combinationIndex) samples))
                           columns (mapv (fn [group]
                                           (if (seq (:axes (first group)))
                                             (component-family-matrix snapshot components group)
                                             (let [items (mapv #(component-sample-item snapshot components %) group)
                                                 width (apply max 280 (map :width items))
                                                 flow (flow-layout items 0 44 width 24 20)
                                                 title (str (:familyName (first group)) " · " (:classification (first group)))]
                                             {:width width :height (:end-y flow)
                                              :build (fn [x y]
                                                       (into [(board-text snapshot (decoration-id) title x y
                                                                          {:size 18 :plain-name? true})]
                                                             (mapcat (fn [item [ix iy]] ((:build item) (+ x ix) (+ y iy)))
                                                                     items (:positions flow))))}))) groups)
                           legacy (if (some? samples) (filter #(= "located" (:kind %)) (:families refs)) (:families refs))
                           items (into columns (keep #(family-item snapshot
                                                               components
                                                               placements
                                                               %)
                                               legacy))]
                          (if (seq items)
                            items
                            [(empty-state-item snapshot
                                               (runtime-id snapshot :designSystem :componentsEmpty)
                                               "暂无组件")]))
          family-layout (balanced-flow family-items 0)
          families-flow (flow-layout family-items
                                     components-x (+ tokens-top 48)
                                     (max content-width (:width family-layout)) 32 32)
          families-end-y (max (:end-y families-flow) (+ tokens-top 28))
          families-right (reduce max components-x
                                 (map (fn [item [x _y]] (+ x (:width item)))
                                      family-items (:positions families-flow)))
          white-shell   (decoration-rect (decoration-id)
                                         (- components-x 32)
                                         (- tokens-top 16)
                                         (+ (max content-width (- families-right components-x)) 64)
                                         (+ (- families-end-y tokens-top) 40)
                                         "#ffffff")]
      {:shapes
       (concat
        tokens-shapes
        [white-shell
         (board-text snapshot (runtime-id snapshot :designSystem :componentsSection)
                     "Components（组件源）"
                     components-x tokens-top
                     {:size 13 :opacity 0.65 :plain-name? true})]
        (mapcat (fn [item [x y]] ((:build item) x y))
                family-items (:positions families-flow)))
       :end-y (max tokens-end-y families-end-y)}))

(defn- project-design-system-page
  "Generated Design System page inside the normal workspace projection
  (DSE-003). With combination-aware refs this is the fully-expanded Token
  panorama (DSE-R17~R26). The page exists only in the projection and is
  never written back to the Package; decorations carry no write target."
  [snapshot placements]
  (when (some? (get-in snapshot [:runtime :designSystemPage]))
    (let [page-id  (uuid/parse (get-in snapshot [:runtime :designSystemPage]))
          board    (runtime-id snapshot :designSystem :board)
          refs     (design-system-refs snapshot)]
      (if (contains? refs :combinations)
        ;; All types and valid combinations, without a switching controller.
        (let [panorama (project-panorama-shapes snapshot placements refs)
              summary (str (count displayed-token-types) " 个展示分组 · "
                           (count (:combinations refs)) " 个有效组合")]
          (adopt-and-build-board snapshot page-id board
                                 (concat
                                  [(board-text snapshot (runtime-id snapshot :designSystem :tokenLabel)
                                               "Design System" 40 40
                                               {:size 20 :plain-name? true})
                                   (board-text snapshot (decoration-id)
                                               summary 40 74
                                               {:size 12 :opacity 0.6 :plain-name? true})]
                                  (:shapes panorama))
                                 "Design System"))
        (if (some? refs)
          ;; Backend refs without combinations (pre-R17 snapshot shape):
          ;; keep the R10/R11/R12 board layout.
          (let [components       (component-index snapshot)
                pad              40
                content-width    640
                token-items      (let [items (specimen-items snapshot refs content-width)]
                                   (if (seq items)
                                     items
                                     [(empty-state-item snapshot
                                                        (runtime-id snapshot :designSystem :tokensEmpty)
                                                        "No Tokens")]))
                tokens-flow      (flow-layout token-items pad (+ pad 76)
                                              content-width 28 24)
                tokens-end-y     (max (:end-y tokens-flow) (+ pad 76 specimen-cell-height))
                families-start-y (+ tokens-end-y 48)
                family-items     (let [items (vec (keep #(family-item snapshot
                                                                         components
                                                                         placements
                                                                         %)
                                                         (:families refs)))]
                                   (if (seq items)
                                     items
                                     [(empty-state-item snapshot
                                                        (runtime-id snapshot :designSystem :componentsEmpty)
                                                        "No Components")]))
                families-flow    (flow-layout family-items
                                              pad families-start-y
                                              content-width 48 32)
                all-shapes       (concat
                                  [(board-text snapshot (runtime-id snapshot :designSystem :tokenLabel)
                                               "Design System" pad pad
                                               {:size 20 :plain-name? true})
                                   (board-text snapshot (runtime-id snapshot :designSystem :tokensSection)
                                               "Tokens" pad (+ pad 40)
                                               {:size 13 :opacity 0.6 :plain-name? true})
                                   (board-text snapshot (runtime-id snapshot :designSystem :componentsSection)
                                               "Components" pad (+ tokens-end-y 8)
                                               {:size 13 :opacity 0.6 :plain-name? true})]
                                  (mapcat (fn [item [x y]] ((:build item) x y))
                                          token-items (:positions tokens-flow))
                                  (mapcat (fn [item [x y]] ((:build item) x y))
                                          family-items (:positions families-flow)))]
            (adopt-and-build-board snapshot page-id board all-shapes "Design System"))
          ;; Legacy fallback for backends without design-system-refs: single
          ;; color swatch + single component root (pre-DSE-004 shape).
          (let [pad        40
                color      (design-system-color-sample snapshot)
                sample     (design-system-component-sample placements)
                board-title (runtime-id snapshot :designSystem :tokenLabel)
                token-swatch (runtime-id snapshot :designSystem :tokenSwatch)
                component-sample (runtime-id snapshot :designSystem :componentSample)
                package-id (-> snapshot :manifest :packageId)
                file-id    (-> snapshot :runtime :file uuid/parse)
                label-text-legacy (if color
                                    (str (:set-name color) "/" (:name color)
                                         " = " (:value color))
                                    "No color token")
                board-shape (cts/setup-shape
                             {:id board
                              :type :frame
                              :name "Design System"
                              :x 0 :y 0
                              :width 480
                              :height 240
                              :parent-id uuid/zero
                              :fills [{:fill-color "#fafafa" :fill-opacity 1}]
                              :shapes
                              (cond-> [board-title token-swatch]
                                (some? sample) (conj component-sample))
                              :plugin-data
                              {:smallpen {"design-system" "decoration"}}})
                label-shape (cts/setup-shape
                               {:id board-title
                                :type :text
                                :name "Token label"
                                :x pad :y pad
                                :width 320 :height 24
                                :grow-type :auto-width
                                :parent-id board
                                :content
                                (project-text-content
                                 snapshot
                                 label-text-legacy
                                 [{:color "#111827" :type "solid"}]
                                 {:fontFamily "Inter"
                                  :fontId "gfont-inter"
                                  :fontSize 14
                                  :fontVariantId "regular"
                                  :fontWeight 400}
                                 nil)
                                :plugin-data
                                {:smallpen {"design-system" "decoration"}}})
                  swatch-shape (cts/setup-shape
                                (cond-> {:id token-swatch
                                         :type :rect
                                         :name (if color
                                                 (str "Token / " (:set-name color)
                                                      "/" (:name color))
                                                 "Token sample")
                                         :x pad :y (+ pad 40)
                                         :width 96 :height 48
                                         :parent-id board
                                         :plugin-data
                                         {:smallpen
                                          {"design-system" "source"
                                           "design-system-ref"
                                           (design-system-ref-data
                                            {:kind "token-cell"
                                             :ownerPackageId package-id
                                             :tokenId (:id color)
                                             :path (:name color)
                                             :setId (:set-id color)
                                             :setName (:set-name color)
                                             :type (:type color)
                                             :value (:value color)})}}}
                                  (some? color)
                                  (assoc :fills
                                         [{:fill-color (:value color)
                                           :fill-opacity 1}])))
                  instance-shape
                  (when sample
                    (let [{:keys [component-id component-set variant offset-x
                                  offset-y]} sample
                          root (lookup (:nodes variant) (:rootId variant))]
                      (cts/setup-shape
                       {:id component-sample
                        :type (node-type (:type root))
                        :name (variant-label component-set variant)
                        :x (+ pad offset-x) :y (+ pad 120 offset-y)
                        :width (:width root) :height (:height root)
                        :parent-id board
                        :component-id (runtime-id snapshot
                                                  :variants
                                                  component-id
                                                  (:id variant))
                        :component-file file-id
                        :component-root true
                        :shape-ref (runtime-id snapshot
                                               :componentNodes
                                               component-id
                                               (:id variant)
                                               (:rootId variant))
                        :plugin-data
                        {:smallpen
                         {"design-system" "source"
                          "design-system-ref"
                          (design-system-ref-data
                           {:kind "component-definition"
                            :ownerPackageId package-id
                            :componentSetId component-id
                            :variantId (:id variant)
                            :sourceNodeId (:rootId variant)})}}})))
                  objects     (cond-> {board board-shape
                                       board-title label-shape
                                       token-swatch swatch-shape}
                                (some? instance-shape)
                                (assoc component-sample instance-shape))]
              (-> (ctp/make-empty-page {:id page-id :name "Design System"})
                  (assoc :objects (assoc objects uuid/zero
                                         (-> (get-in ctp/empty-page-data
                                                     [:objects uuid/zero])
                                             (assoc :shapes [board]))))
                  (assoc :plugin-data {:smallpen {"design-system-page" true}}))))))))

(defn- project-component-sets

  "One Penpot component per variant. Penpot groups components by :path, so the
  Component Set name becomes the path and the axis selection becomes the name."
  [snapshot placements]
  (into {}
        (map (fn [{:keys [component-id component-set variant]}]
               (let [cmp-id (runtime-id snapshot
                                        :variants
                                        component-id
                                        (:id variant))]
                 [cmp-id
                  {:id cmp-id
                   :name (variant-label component-set variant)
                   :path (:name component-set)
                   :main-instance-id (runtime-id snapshot
                                                 :componentNodes
                                                 component-id
                                                 (:id variant)
                                                 (:rootId variant))
                   :main-instance-page (-> snapshot
                                           :runtime
                                           :componentsPage
                                           uuid/parse)}])))
        placements))

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
        placements (variant-placements (component-set-index snapshot))
        assets     (asset-library snapshot)
        dtcg-tokens (snapshot-dtcg-token-definitions snapshot)
        tokens-lib (if-let [library (token-library snapshot)]
                     (project-token-library snapshot library)
                     (if (seq dtcg-tokens)
                       (ctob/make-tokens-lib)
                       (default-token-library)))
        tokens-lib (add-dtcg-token-set snapshot tokens-lib dtcg-tokens)
        screen-pages (->> (get-in manifest [:entries :screens])
                          (map #(lookup (:entries snapshot) %))
                          (mapcat (fn [screen]
                                    (map #(project-page snapshot components screen %)
                                         (:presentations screen))))
                          (vec))
        pages    (cond-> screen-pages
                   (seq placements)
                   (conj (project-components-page snapshot
                                                  components
                                                  placements))
                   (some? (-> snapshot :runtime :designSystemPage))
                   (conj (project-design-system-page snapshot placements)))
        data     (-> (ctf/make-file-data file-id nil)
                     (assoc :pages (mapv :id pages))
                     (assoc :pages-index (into {} (map (juxt :id identity)) pages))
                     (assoc :components
                            (merge (project-located-components snapshot components)
                                   (project-component-sets snapshot placements)))
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
                             {"locator" (:locator snapshot)
                              "package-id" (:packageId manifest)
                              "revision" (:revision snapshot)}}))
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
