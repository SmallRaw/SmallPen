(ns frontend-tests.smallpen.panorama-probe-test
  "The Penpot projection of the generated Design System page. SmallPen core
  lays the page out (design-system-page.mjs, tested there); these tests
  check that the tree is drawn faithfully with its write targets."
  (:require
   [app.common.uuid :as uuid]
   [app.main.smallpen.projection :as projection]
   [app.util.i18n :refer [tr]]
   [cljs.test :as t]
   [cuerdas.core :as str]
   [frontend-tests.smallpen.ds-tree :as ds]))

(def ^:private page-id (uuid/parse "a1e50000-0000-4000-8000-000000000002"))
(def ^:private board "b0000000-0000-4000-8000-000000000001")

(def combos
  [{:id "cb-light" :label "Light" :selection [] :setIds ["s1"] :themeIds ["t1"]}
   {:id "cb-dark" :label "Dark" :selection [] :setIds ["s2"] :themeIds ["t2"]}])

(defn- snapshot-with
  [refs tree]
  {:manifest {:packageId "pkg" :name "Fixture"}
   :formatCapabilities {:webProjection projection/format-capabilities}
   :runtime {:file "1c241d42-8fd3-56f0-958f-0eabe092adaf"
             :pages {}
             :designSystemPage (str page-id)
             :designSystem {:board board}
             :designSystemRefs refs
             :designSystemTree tree
             :components {}
             :variants {:cmp_test {:var_test "e0000000-0000-4000-8000-000000000001"}}
             :componentNodes {} :nodes {} :fonts {}}})

(defn- page-objects
  [snapshot]
  (get-in (projection/project-snapshot snapshot {:file-id uuid/zero :project-id uuid/zero})
          [:file :data :pages-index page-id :objects]))

(defn- shape-text
  [shape]
  (str/join "\n"
            (for [block (get-in shape [:content :children])
                  paragraph (:children block)]
              (apply str (map :text (:children paragraph))))))

(defn- sample
  [nodes]
  {:kind "variant" :componentSetId "cmp_test" :variantId "var_test"
   :familyName "Card" :classification "Composite" :variantIndex 0
   :axes [] :selection {} :rootId "node_root"
   :caption (str (uuid/next))
   :runtimeNodes (into {} (map (fn [[id _]] [id (str (uuid/next))])) nodes)
   :sources {}
   :nodes nodes})

(t/deftest component-sample-keeps-every-descendants-exact-source
  (let [children (mapv #(str "child-" %) (range 64))
        item     (-> (sample (into {:node_root {:id "node_root" :type "FRAME" :name "Card"
                                                :children children :x 0 :y 0 :width 600 :height 100}}
                                   (map-indexed (fn [index id]
                                                  [(keyword id) {:id id :type "RECTANGLE" :name id
                                                                 :children [] :width 8 :height 8
                                                                 :x index :y 4}]))
                                   children))
                     (assoc :sources (into {}
                                           (map-indexed (fn [index id]
                                                          [(keyword id) {:nodeId (str "source-" index)
                                                                         :variantId "var_test"
                                                                         :occurrencePath id
                                                                         :overrideNodeId "nested-instance"}]))
                                           children)))
        refs     {:specimens {} :combinations combos :componentSamples [item]}
        objects  (page-objects (snapshot-with refs (ds/ds-tree board {} 1 [])))]
    (doseq [[index node-id] (map-indexed vector children)]
      (let [shape (get objects (uuid/parse (get-in item [:runtimeNodes (keyword node-id)])))
            ref   (js/JSON.parse (get-in shape [:plugin-data :smallpen "design-system-ref"]))]
        (t/is (= [(str "source-" index) node-id "nested-instance"]
                 [(.-sourceNodeId ref) (.-occurrencePath ref) (.-overrideNodeId ref)]))))))

(t/deftest a-sample-lands-exactly-on-its-placeholder
  (let [item    (sample {:node_root {:id "node_root" :type "FRAME" :name "Card"
                                     :children [] :x 7 :y 9 :width 160 :height 80}})
        tree    (ds/ds-tree board {} 1 [])
        spot    (some (fn [[_ node]] (when (= "component-sample" (get-in node [:designSystem :role])) node))
                      (:nodes tree))
        objects (page-objects (snapshot-with {:specimens {} :componentSamples [item]} tree))
        root    (get objects (uuid/parse (get-in item [:runtimeNodes :node_root])))]
    (t/is (= [(:x spot) (:y spot)] [(:x root) (:y root)]))
    (t/is (= (uuid/parse board) (:parent-id root)))
    (t/is (nil? (:main-instance root)) "a sample is a preview, not a second main")))

;; DSE-R19 regression: a color specimen's swatch is a real color chip — its
;; fill IS the Token Cell value, and the shape names the Cell it writes to.
(t/deftest color-specimen-carries-token-fill-and-its-cell
  (let [ref     {:ownerPackageId "pkg" :path "primary" :raw "#6750a4" :setId "s1"
                 :setName "color/light" :tokenId "tokc" :type "color" :value "#6750a4"
                 :attribute "fill" :combinationIds ["cb-light"] :combinationId "cb-light"
                 :caption "cccccccc-0000-4000-8000-000000000011"
                 :shape "cccccccc-0000-4000-8000-000000000012"}
        refs    {:specimens {"tokc@cb-light" ref} :combinations combos}
        objects (page-objects (snapshot-with refs (ds/ds-tree board {(keyword "tokc@cb-light") ref} 0 [])))
        swatch  (get objects (uuid/parse (:shape ref)))
        target  (js/JSON.parse (get-in swatch [:plugin-data :smallpen "design-system-ref"]))]
    (t/is (= [{:fill-color "#6750a4" :fill-opacity 1}] (:fills swatch)))
    (t/is (= "token-cell" (get-in swatch [:plugin-data :smallpen "design-system-kind"])))
    (t/is (= "tokc" (.-tokenId target)))))

(t/deftest page-text-is-the-trees-own-text
  ;; Labels arrive translated in the tree; the projection adds none.
  (let [tree    (-> (ds/ds-tree board {} 0 [])
                    (assoc-in [:nodes :node_title]
                              {:id "node_title" :type "TEXT" :name "设计系统" :text "设计系统"
                               :x 40 :y 40 :width 200 :height 40 :children []
                               :textStyle {:fontFamily "Source Sans Pro" :fontSize 28 :fontWeight 600}
                               :designSystem {:role "decoration"}})
                    (assoc-in [:runtimeIds :node_title] "b0000000-0000-4000-8000-000000000002"))
        tree    (update-in tree [:nodes (keyword (:rootId tree)) :children] conj "node_title")
        objects (page-objects (snapshot-with {:specimens {}} tree))
        title   (get objects (uuid/parse "b0000000-0000-4000-8000-000000000002"))]
    (t/is (= "设计系统" (shape-text title)))
    (t/is (= "decoration" (get-in title [:plugin-data :smallpen "design-system"])))))

(t/deftest without-a-tree-the-page-is-an-empty-board
  (let [objects (page-objects (snapshot-with {:specimens {}} nil))]
    (t/is (= #{uuid/zero (uuid/parse board)} (set (keys objects))))
    (t/is (= (tr "smallpen.design-system") (:name (get objects (uuid/parse board)))))))

(t/deftest board-layers-follow-the-tree-order
  ;; A card shell comes before its content in the tree, so it is drawn
  ;; under it; map order would let shells hide swatches at random.
  (let [ids   (mapv #(str "b1000000-0000-4000-8000-00000000000" %) (range 1 10))
        nodes (into {}
                    (map-indexed (fn [index _]
                                   [(keyword (str "node_" index))
                                    {:id (str "node_" index) :type "RECTANGLE" :name (str "Layer " index)
                                     :x 0 :y (* 10 index) :width 10 :height 10 :children []
                                     :designSystem {:role "decoration"}}]))
                    ids)
        order (mapv #(str "node_" %) [8 3 5 0 7 1 6 2 4])
        tree  {:rootId "node_root"
               :nodes (assoc nodes :node_root {:id "node_root" :type "FRAME" :name "Page" :x 0 :y 0
                                               :width 100 :height 100 :children order
                                               :designSystem {:role "decoration"}})
               :runtimeIds (assoc (into {} (map-indexed (fn [index id] [(keyword (str "node_" index)) id])) ids)
                                  :node_root board)}
        objects (page-objects (snapshot-with {:specimens {}} tree))]
    (t/is (= (mapv #(uuid/parse (nth ids (js/parseInt (subs % 5)))) order)
             (:shapes (get objects (uuid/parse board)))))))

(t/deftest a-foundation-sample-draws-without-a-component-in-this-file
  ;; A Product's page shows its Foundation's sets; the Product file has no
  ;; component for them, and the sample is a preview anyway.
  (let [item     (sample {:node_root {:id "node_root" :type "FRAME" :name "Card"
                                      :children [] :x 0 :y 0 :width 160 :height 80}})
        snapshot (-> (snapshot-with {:specimens {} :componentSamples [item]} (ds/ds-tree board {} 1 []))
                     (assoc-in [:runtime :variants] {}))
        root     (get (page-objects snapshot) (uuid/parse (get-in item [:runtimeNodes :node_root])))]
    (t/is (some? root))
    (t/is (nil? (:component-id root)))))
