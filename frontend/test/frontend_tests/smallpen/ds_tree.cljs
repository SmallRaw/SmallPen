(ns frontend-tests.smallpen.ds-tree
  "A minimal Design System page tree shaped like SmallPen core's
  buildDesignSystemPage output (design-system-page.mjs) after js->clj: the
  board, one node per token specimen, and one placeholder per component
  sample or located family, stacked top to bottom. Tests of the Penpot
  projection draw it; the layout itself is tested in smallpen core."
  (:require
   [app.common.uuid :as uuid]))

(defn- specimen-node
  [key ref y]
  (let [value (if (and (:alias ref) (not (:unresolvedAlias ref))) (:resolved ref) (:value ref))
        base  {:children []
               :designSystem {:role "token-cell" :specimen (name key)}
               :name (str "Token / " (:setName ref) "/" (:path ref))
               :x 40
               :y y}]
    (merge
     (case (or (:attribute ref) (:type ref))
       "fill"       (assoc base :type "RECTANGLE" :width 64 :height 64
                           :fills [{:color value :type "solid"}])
       "radius"     (assoc base :type "RECTANGLE" :width 64 :height 64
                           :cornerRadius value)
       "gap"        (assoc base :type "FRAME" :width (+ 8 value) :height 16
                           :layout "flex" :layout-flex-dir "row"
                           :layout-gap {:row-gap value :column-gap value}
                           :layout-gap-type "fixed")
       "shadow"     (assoc base :type "RECTANGLE" :width 96 :height 56
                           :fills [{:color "#ffffff" :type "solid"}]
                           :shadow value)
       "typography" (assoc base :type "TEXT" :width 400 :height 48
                           :text "Ag" :textStyle value)
       (assoc base :type "RECTANGLE" :width 96 :height 48))
     (:node ref))))

(defn ds-tree
  "specimens: {key ref}; a ref may carry :node fields that override its
  node. samples: count of component samples (placeholders by index).
  families: the refs families; located ones get a placeholder."
  [board specimens samples families]
  (let [counter  (atom 0)
        nodes    (atom {})
        runtime  (atom {})
        add!     (fn [node runtime-id]
                   (let [id (str "node_ds_" (swap! counter inc))]
                     (swap! nodes assoc (keyword id) (assoc node :id id))
                     (swap! runtime assoc (keyword id) (or runtime-id (str (uuid/next))))
                     id))
        y        (atom 100)
        place!   (fn [height] (let [top @y] (swap! y + height 40) top))
        children (atom [])]
    (doseq [[key ref] specimens]
      (let [top  (place! 80)
            node (specimen-node key ref top)
            node (if (= "FRAME" (:type node))
                   (let [[a b] (or (:children ref) [nil nil])
                         left  (add! {:type "RECTANGLE" :name "Specimen filler" :width 4 :height 16
                                      :x 0 :y 0 :children [] :designSystem {:role "decoration"}} a)
                         right (add! {:type "RECTANGLE" :name "Specimen filler" :width 4 :height 16
                                      :x (+ 4 (:width node) -8) :y 0 :children []
                                      :designSystem {:role "decoration"}} b)]
                     (assoc node :children [right left]))
                   node)]
        (swap! children conj (add! node (:shape ref)))))
    (doseq [index (range samples)]
      (swap! children conj
             (add! {:type "FRAME" :name "Sample" :x 40 :y (place! 120) :width 160 :height 80
                    :children [] :designSystem {:role "component-sample" :sample index}} nil)))
    (doseq [[index family] (map-indexed vector families)
            :when (= "located" (:kind family))]
      (let [top (place! 150)]
        (swap! children conj
               (add! {:type "TEXT" :name (str (:label family)) :text (str (:label family))
                      :x 40 :y top :width 400 :height 20 :children []
                      :designSystem {:role "caption"}}
                     (:caption family))
               (add! {:type "FRAME" :name "Located" :x 40 :y (+ top 28) :width 100 :height 40
                      :children [] :designSystem {:role "located-family" :family index}} nil))))
    (let [root (add! {:type "FRAME" :name "Design System" :x 0 :y 0 :width 1200 :height @y
                      :children @children :fills [{:color "#eef1f5" :type "solid"}]
                      :designSystem {:role "decoration"}}
                     board)]
      {:nodes @nodes :rootId root :runtimeIds @runtime})))
