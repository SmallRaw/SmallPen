(ns frontend-tests.smallpen.panorama-probe-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.smallpen.projection :as projection]
   [cljs.test :as t]))

;; Minimal combination-aware refs (same shape the runtime emits for the demo
;; package): two combinations, one radius Cell covered by both, one archived
;; Cell covered by none.
(def combos
  [{:id "cb-light" :label "Light" :selection [] :setIds ["s1"] :themeIds ["t1"]}
   {:id "cb-dark" :label "Dark" :selection [] :setIds ["s2"] :themeIds ["t2"]}])

(def specimens
  {"tok1@cb-light"
   {:ownerPackageId "pkg" :order 0 :path "base" :raw 8 :setId "s1" :setName "radius/md"
    :status "active" :tokenId "tok1" :type "border-radius" :value 8 :attribute "radius"
    :writable true :alias false :resolved 8 :resolvedFrom nil :unresolvedAlias false
    :aliasCycle false :combinationIds ["cb-light" "cb-dark"] :combinationId "cb-light"
    :caption "cccccccc-0000-4000-8000-000000000001"
    :shape "cccccccc-0000-4000-8000-000000000002"}
   "tok1@cb-dark"
   {:ownerPackageId "pkg" :order 0 :path "base" :raw 8 :setId "s1" :setName "radius/md"
    :status "active" :tokenId "tok1" :type "border-radius" :value 8 :attribute "radius"
    :writable true :alias false :resolved 8 :resolvedFrom nil :unresolvedAlias false
    :aliasCycle false :combinationIds ["cb-light" "cb-dark"] :combinationId "cb-dark"
    :caption "cccccccc-0000-4000-8000-000000000003"
    :shape "cccccccc-0000-4000-8000-000000000004"}
   "tok9"
   {:ownerPackageId "pkg" :order 1 :path "legacy" :raw "#cccccc" :setId "s9" :setName "color/archived"
    :status "archived" :tokenId "tok9" :type "color" :value "#cccccc" :attribute "fill"
    :writable true :alias false :resolved "#cccccc" :resolvedFrom nil :unresolvedAlias false
    :aliasCycle false :combinationIds [] :combinationId nil
    :caption "cccccccc-0000-4000-8000-000000000005"
    :shape "cccccccc-0000-4000-8000-000000000006"}})

(defn- project-specimens
  [items & [combinations samples]]
  (let [ids (mapv #(str "b0000000-0000-4000-8000-00000000000" %) (range 1 9))
        snapshot {:manifest {:packageId "pkg" :name "Fixture"}
                  :formatCapabilities {:webProjection projection/format-capabilities}
                  :runtime {:file "1c241d42-8fd3-56f0-958f-0eabe092adaf"
                            :pages {}
                            :designSystemPage "a1e50000-0000-4000-8000-000000000002"
                            :designSystem (zipmap [:board :tokenLabel :tokensSection
                                                  :componentsSection :pagesSection :tokensEmpty
                                                  :componentsEmpty :pagesEmpty] ids)
                            :designSystemRefs (cond-> {:specimens items :combinations (or combinations combos)
                                                       :families [] :pages []}
                                                samples (assoc :componentSamples samples))
                            :components {} :variants {:cmp_test {:var_test "e0000000-0000-4000-8000-000000000001"}}
                            :componentNodes {} :nodes {} :fonts {}}}
        result (projection/project-snapshot snapshot {:file-id uuid/zero :project-id uuid/zero})]
    (get-in result [:file :data :pages-index
                    (uuid/parse "a1e50000-0000-4000-8000-000000000002") :objects])))

(t/deftest component-samples-stack-in-one-family-column-with-exact-source-identity
  (let [samples (mapv (fn [index]
                        {:kind "variant" :componentSetId "cmp_test" :variantId "var_test"
                         :familyName "Card" :classification "Primitive" :variantIndex 0
                         :rootId "node_root" :label "Card · idle" :combinationLabel (if (zero? index) "Light" "Dark")
                         :caption (str "e1000000-0000-4000-8000-00000000000" index)
                         :runtimeNodes {:node_root (str "e2000000-0000-4000-8000-00000000000" index)}
                         :sources {:node_root {:nodeId "node_root" :componentId "cmp_test" :variantId "var_test"}}
                         :nodes {:node_root {:id "node_root" :type "FRAME" :name "Card"
                                             :children [] :x 0 :y 0 :width 200 :height 100
                                             :cornerRadius 8 :fills [{:color "#ffffff" :type "solid"}]}}})
                      [0 1])
        objects (project-specimens {} combos samples)
        roots (mapv #(get objects (uuid/parse (get-in % [:runtimeNodes :node_root]))) samples)
        pages-heading (get objects (uuid/parse "b0000000-0000-4000-8000-000000000005"))
        empty-page (get objects (uuid/parse "b0000000-0000-4000-8000-000000000008"))]
    (t/is (= (:x (first roots)) (:x (second roots))))
    (t/is (> (:y (second roots)) (+ (:y (first roots)) (:height (first roots)))))
    (t/is (nil? pages-heading))
    (t/is (nil? empty-page))
    (t/is (= 2 (count (filter #(.startsWith (or (:name %) "") "Component sample ·") (vals objects)))))
    (doseq [root roots]
      (t/is (nil? (:main-instance root)))
      (let [ref (js->clj (js/JSON.parse (get-in root [:plugin-data :smallpen "design-system-ref"])))]
        (t/is (= "node_root" (get ref "sourceNodeId")))))))

(t/deftest empty-combinations-still-show-all-type-cards
  (let [objects (project-specimens {} [])
        cards (filter #(.startsWith (or (:name %) "") "Token type ·") (vals objects))]
    (t/is (= 14 (count cards)))
    (t/is (every? #(= [{:fill-color "#ffffff" :fill-opacity 1}] (:fills %)) cards))))

(t/deftest component-matrix-preserves-all-samples-and-aligns-dimensions
  (let [axes [{:id "style" :name "Style" :role "configuration" :domain ["primary" "secondary" "ghost"]}
              {:id "content" :name "Content" :role "configuration" :domain ["text" "leading" "trailing" "icon"]}
              {:id "state" :name "State" :role "state" :domain ["default" "hover" "pressed" "disabled"]}]
        samples (mapv (fn [i [style content state theme]]
                        {:componentSetId "cmp_test" :variantId "var_test" :familyName "Button"
                         :classification "Primitive" :variantIndex i :axes axes
                         :selection {:style style :content content :state state}
                         :combinationId theme :combinationLabel theme :rootId "node_root"
                         :label (str "Button / " style " / " content " / " state)
                         :caption (str (uuid/next)) :runtimeNodes {:node_root (str (uuid/next))}
                         :sources {:node_root {:nodeId "node_root" :componentId "cmp_test" :variantId "var_test"}}
                         :nodes {:node_root {:id "node_root" :type "FRAME" :name "Button"
                                             :x 0 :y 0 :width 152 :height 44 :children []}}})
                      (range)
                      (for [style ["primary" "secondary" "ghost"]
                            content ["text" "leading" "trailing" "icon"]
                            state ["default" "hover" "pressed" "disabled"]
                            theme ["Light" "Dark"]]
                        [style content state theme]))
        objects (project-specimens {} combos samples)
        roots (mapv #(get objects (uuid/parse (get-in % [:runtimeNodes :node_root]))) samples)
        matrices (filter #(.startsWith (or (:name %) "") "Component matrix ·") (vals objects))
        root-at (fn [content state]
                  (let [sample (some #(when (and (= {:style "primary" :content content :state state} (:selection %))
                                                (= "Light" (:combinationId %))) %) samples)]
                    (get objects (uuid/parse (get-in sample [:runtimeNodes :node_root])))))]
    (t/is (= 96 (count (filter some? roots))))
    (t/is (= 6 (count matrices)))
    (t/is (= (:y (root-at "text" "default")) (:y (root-at "leading" "default"))))
    (t/is (< (:x (root-at "text" "default")) (:x (root-at "leading" "default"))))
    (t/is (= (:x (root-at "text" "default")) (:x (root-at "text" "hover"))))
    (t/is (< (- (apply max (map :y roots)) (apply min (map :y roots))) 2000))
    (doseq [root roots]
      (t/is (= [152 44] ((juxt :width :height) root)))
      (t/is (some? (get-in root [:plugin-data :smallpen "design-system-ref"]))))))

(t/deftest matrix-adapts-to-two-and-three-dimensions-and-wide-previews
  (doseq [with-state? [false true]]
    (let [axes (cond-> [{:id "size" :name "Custom size" :role "configuration"
                         :domain (mapv str (range 7))}]
                 with-state? (conj {:id "status" :name "Custom status" :role "state" :domain ["a" "b"]}))
          samples (mapv (fn [[size status theme]]
                          {:componentSetId "cmp_test" :variantId "var_test" :familyName "Unknown component"
                           :axes axes :classification "Composite" :rootId "node_root"
                           :selection (cond-> {:size size} with-state? (assoc :status status))
                           :combinationId theme :combinationLabel theme :label "Custom"
                           :caption (str (uuid/next)) :runtimeNodes {:node_root (str (uuid/next))}
                           :sources {:node_root {:nodeId "node_root"}}
                           :nodes {:node_root {:id "node_root" :name "Preview" :type "FRAME"
                                               :x 0 :y 0 :width 320 :height 240 :children []}}})
                        (for [size (map str (range 7))
                              status (if with-state? ["a" "b"] [nil])
                              theme ["Light" "Dark"]]
                          [size status theme]))
          objects (project-specimens {} combos samples)
          roots (mapv #(get objects (uuid/parse (get-in % [:runtimeNodes :node_root]))) samples)
          panels (filter #(.startsWith (or (:name %) "") "Component matrix ·") (vals objects))]
      (t/is (every? some? roots))
      (t/is (= (count roots) (count (set (map (juxt :x :y) roots)))))
      (t/is (every? #(<= (:width %) 2400) panels) "large domains split into bounded matrix blocks")
      (t/is (every? #(= [320 240] ((juxt :width :height) %)) roots))
      (doseq [a roots b roots :when (not= (:id a) (:id b))]
        (t/is (or (<= (+ (:x a) (:width a)) (:x b))
                  (<= (+ (:x b) (:width b)) (:x a))
                  (<= (+ (:y a) (:height a)) (:y b))
                  (<= (+ (:y b) (:height b)) (:y a))))))))

(t/deftest spacing-ruler-measures-only-the-gap
  (doseq [gap [4 8 16]]
    (let [ref (assoc (get specimens "tok1@cb-light")
                     :type "spacing" :attribute "gap" :raw gap :value gap
                     :children ["eeeeeeee-0000-4000-8000-000000000001"
                                "eeeeeeee-0000-4000-8000-000000000002"])
          objects (project-specimens {"gap" ref})
          frame (get objects (uuid/parse (:shape ref)))
          ruler (some #(when (and (= (:y %) (+ (:y frame) 52))
                                  (= 1 (:height %))
                                  (= [{:fill-color "#94a3b8" :fill-opacity 1}] (:fills %))) %)
                      (vals objects))]
      (t/is (= gap (:width ruler)))
      (t/is (= (+ (:x frame) 32) (:x ruler))))))

(t/deftest panorama-projects-combination-specimens
  (let [snapshot {:manifest {:packageId "pkg" :name "Fixture"}
                  :formatCapabilities {:webProjection projection/format-capabilities}
                  :runtime {:file "1c241d42-8fd3-56f0-958f-0eabe092adaf"
                            :pages {}
                            :designSystemPage "a1e50000-0000-4000-8000-000000000002"
                            :designSystem {:board "b0000000-0000-4000-8000-000000000001"
                                           :tokenLabel "b0000000-0000-4000-8000-000000000002"
                                           :tokensSection "b0000000-0000-4000-8000-000000000003"
                                           :componentsSection "b0000000-0000-4000-8000-000000000004"
                                           :pagesSection "b0000000-0000-4000-8000-000000000005"
                                           :tokensEmpty "b0000000-0000-4000-8000-000000000006"
                                           :componentsEmpty "b0000000-0000-4000-8000-000000000007"
                                           :pagesEmpty "b0000000-0000-4000-8000-000000000008"
                                           :combinations {"cb-light" "c0000000-0000-4000-8000-000000000001"
                                                          "cb-dark" "c0000000-0000-4000-8000-000000000002"}
                                           :types {"border-radius" "d0000000-0000-4000-8000-000000000001"
                                                   "color" "d0000000-0000-4000-8000-000000000002"}}
                            :designSystemRefs {:specimens specimens
                                               :combinations combos
                                               :types [{:type "border-radius" :cells 1}
                                                       {:type "color" :cells 1}]
                                               :tokenGroups []
                                               :families []
                                               :pages []}
                            :components {}
                            :variants {}
                            :componentNodes {}
                            :nodes {}
                            :fonts {}}}
        result (projection/project-snapshot snapshot {:file-id uuid/zero :project-id uuid/zero})
        page (get-in result [:file :data :pages-index (uuid/parse "a1e50000-0000-4000-8000-000000000002")])
        objects (:objects page)
        names (into #{} (map (fn [[_ shape]] (:name shape))) objects)
        token-rows (filter #(and (string? %) (.startsWith % "Token /")) names)]
    ;; 2 combination specimens + the archived band specimen.
    (t/is (= #{"Token / radius/md/base · Light"
               "Token / radius/md/base · Dark"
               "Token / color/archived/legacy · Archived · 未激活"}
             (set token-rows)))
    ;; Each type gets its own white card, not a global combination column.
    (t/is (= 14 (count (filter #(and (string? %) (.startsWith % "Token type ·")) names))))
    (t/is (contains? names "Light"))
    (t/is (contains? names "其他 Token"))
    (t/is (not-any? (fn [[_ shape]]
                  (some-> shape :plugin-data :smallpen
                          (get "design-system-combination")))
                objects))))

(t/deftest typography-is-the-only-font-section
  (let [value {:fontFamily "Inter" :fontSize 24 :fontWeight 600 :lineHeight 1.4}
        style (assoc (get specimens "tok1@cb-light")
                     :type "typography" :attribute "typography" :raw value :value value)
        primitive (assoc (get specimens "tok9")
                         :type "font-size" :attribute "font-size" :raw 24 :value 24)
        objects (project-specimens {"style" style "primitive" primitive})
        names (set (map :name (vals objects)))]
    (t/is (contains? names "Token type · typography"))
    (t/is (some? (get objects (uuid/parse (:shape style)))))
    (t/is (nil? (get objects (uuid/parse (:shape primitive)))))
    (doseq [type ["font-family" "font-size" "font-weight" "letter-spacing"
                 "text-case" "text-decoration"]]
      (t/is (not (contains? names (str "Token type · " type)))))))

;; DSE-R19 regression: a color specimen's swatch is a real color chip — its
;; fill IS the Token Cell value. When it was projected without fills it fell
;; back to the shape default (#B1B2B5), which also poisoned the FILL panel's
;; undo inverse (the undo wrote the default gray into the Cell instead of the
;; previous Token value, so undo never restored the source).
(t/deftest panorama-color-specimen-carries-token-fill
  (let [specimens {"tokc@cb-light"
                   {:ownerPackageId "pkg" :order 0 :path "primary" :raw "#6750a4"
                    :setId "s1" :setName "color/light" :status "active" :tokenId "tokc"
                    :type "color" :value "#6750a4" :attribute "fill" :writable true
                    :alias false :resolved "#6750a4" :resolvedFrom nil :unresolvedAlias false
                    :aliasCycle false :combinationIds ["cb-light"] :combinationId "cb-light"
                    :caption "cccccccc-0000-4000-8000-000000000011"
                    :shape "cccccccc-0000-4000-8000-000000000012"}}
        snapshot {:manifest {:packageId "pkg" :name "Fixture"}
                  :formatCapabilities {:webProjection projection/format-capabilities}
                  :runtime {:file "1c241d42-8fd3-56f0-958f-0eabe092adaf"
                            :pages {}
                            :designSystemPage "a1e50000-0000-4000-8000-000000000002"
                            :designSystem {:board "b0000000-0000-4000-8000-000000000001"
                                           :tokenLabel "b0000000-0000-4000-8000-000000000002"
                                           :tokensSection "b0000000-0000-4000-8000-000000000003"
                                           :componentsSection "b0000000-0000-4000-8000-000000000004"
                                           :pagesSection "b0000000-0000-4000-8000-000000000005"
                                           :tokensEmpty "b0000000-0000-4000-8000-000000000006"
                                           :componentsEmpty "b0000000-0000-4000-8000-000000000007"
                                           :pagesEmpty "b0000000-0000-4000-8000-000000000008"
                                           :combinations {"cb-light" "c0000000-0000-4000-8000-000000000001"}
                                           :types {"color" "d0000000-0000-4000-8000-000000000002"}}
                            :designSystemRefs {:specimens specimens
                                               :combinations combos
                                               :types [{:type "color" :cells 1}]
                                               :tokenGroups []
                                               :families []
                                               :pages []}
                            :components {}
                            :variants {}
                            :componentNodes {}
                            :nodes {}
                            :fonts {}}}
        result (projection/project-snapshot snapshot {:file-id uuid/zero :project-id uuid/zero})
        page (get-in result [:file :data :pages-index (uuid/parse "a1e50000-0000-4000-8000-000000000002")])
        swatch (->> (:objects page)
                    vals
                    (filter #(= "Token / color/light/primary · Light" (:name %)))
                    (first))]
    (t/is (some? swatch))
    (t/is (= [{:fill-color "#6750a4" :fill-opacity 1}] (:fills swatch)))))
