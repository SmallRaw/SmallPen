;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.projection-test
  (:require
   [app.common.files.validate :as cfv]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.types.path :as path]
   [app.common.types.shape-tree :as ctst]
   [app.common.types.shape.shadow :as ctss]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as session]
   [app.main.smallpen.token-state :as spts]
   [cljs.test :as t]
   [frontend-tests.smallpen.ds-tree :as ds]))

(def cos30 (/ (js/Math.sqrt 3) 2))

(defn- close?
  [expected actual]
  (and (number? actual) (< (js/Math.abs (- expected actual)) 1e-9)))

(defn- close-matrix?
  [expected actual]
  (every? #(close? (% expected) (% actual)) [:a :b :c :d :e :f]))

(defn- close-points?
  [expected actual]
  (and (= (count expected) (count actual))
       (every? true? (map #(and (close? (:x %1) (:x %2))
                                (close? (:y %1) (:y %2)))
                          expected
                          actual))))

(defn- corners
  "Penpot points of a half-width x half-height box turned by [a b c d] about
  its page center (cx, cy): top-left, top-right, bottom-right, bottom-left."
  [cx cy a b c d hw hh]
  (mapv (fn [[x y]]
          (gpt/point (+ cx (* a x) (* c y)) (+ cy (* b x) (* d y))))
        [[(- hw) (- hh)] [hw (- hh)] [hw hh] [(- hw) hh]]))

(def file-id #uuid "aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa")
(def project-id #uuid "bbbbbbbb-bbbb-bbbb-8bbb-bbbbbbbbbbbb")
(def team-id #uuid "cccccccc-cccc-cccc-8ccc-cccccccccccc")
(def page-id #uuid "11111111-1111-1111-8111-111111111111")
(def canvas-id #uuid "22222222-2222-2222-8222-222222222222")
(def rectangle-id #uuid "33333333-3333-3333-8333-333333333333")
(def component-id #uuid "44444444-4444-4444-8444-444444444444")
(def component-main-id #uuid "55555555-5555-4555-8555-555555555555")
(def component-child-id #uuid "66666666-6666-4666-8666-666666666666")
(def instance-id #uuid "77777777-7777-4777-8777-777777777777")
(def instance-child-id #uuid "88888888-8888-4888-8888-888888888888")
(def token-set-id #uuid "99999999-9999-4999-8999-999999999999")
(def color-token-id #uuid "aaaaaaaa-1111-4111-8111-111111111111")
(def sizing-token-id #uuid "bbbbbbbb-2222-4222-8222-222222222222")
(def token-theme-id #uuid "cccccccc-3333-4333-8333-333333333333")
(def dtcg-token-set-id #uuid "20202020-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
(def dtcg-token-id #uuid "21212121-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
(def library-color-id #uuid "dddddddd-4444-4444-8444-444444444444")
(def library-typography-id #uuid "eeeeeeee-5555-4555-8555-555555555555")
(def library-media-id #uuid "ffffffff-6666-4666-8666-666666666666")
(def library-media-storage-id #uuid "12121212-7777-4777-8777-777777777777")
(def library-font-id #uuid "13131313-8888-4888-8888-888888888888")
(def library-font-variant-id #uuid "14141414-9999-4999-8999-999999999999")
(def library-font-file-id #uuid "15151515-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
(def flow-id #uuid "16161616-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
(def external-file-id #uuid "17171717-cccc-4ccc-8ccc-cccccccccccc")
(def external-color-id #uuid "18181818-dddd-4ddd-8ddd-dddddddddddd")
(def external-typography-id #uuid "19191919-eeee-4eee-8eee-eeeeeeeeeeee")

(def snapshot
  {:formatCapabilities
   {:webProjection
    (merge
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
                   "children"
                   "componentId"
                   "cornerRadius"
                   "fills"
                   "flipX"
                   "flipY"
                   "growType"
                   "height"
                   "id"
                   "mediaRef"
                   "name"
                   "opacity"
                   "rotation"
                   "sourceNodeId"
                   "strokes"
                   "text"
                   "textBlocks"
                   "textStyle"
                   "touched"
                   "type"
                   "visible"
                   "width"
                   "x"
                   "y"]
      :nodeTypes ["COMPONENT" "FRAME" "IMAGE" "INSTANCE" "RECTANGLE" "TEXT"]
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
                      "visibility-group"]}
     projection/format-capabilities)}
   :entries
   {"screens/roundtrip.json"
    {:basePresentationId "pres_desktop"
     :id "scr_roundtrip"
     :name "Round Trip"
     :presentations
     [{:id "pres_desktop"
       :name "Desktop"
       :nodes
       {:node_canvas
        {:children ["node_rectangle"]
         :fills [{:color "#f4f4f5" :type "solid"}]
         :height 600
         :id "node_canvas"
         :name "Canvas"
         :type "FRAME"
         :width 800
         :x 0
         :y 0}
        :node_rectangle
        {:children []
         :cornerRadius [4 8 12 16]
         :fills [{:color "#7c3aed" :opacity 0.6 :type "solid"}]
         :height 120
         :id "node_rectangle"
         :name "Editable Rectangle"
         :opacity 0.75
         :type "RECTANGLE"
         :width 240
         :x 80
         :y 96
         :visible false}}
       :rootId "node_canvas"}]}}
   :manifest
   {:defaultScreenId "scr_roundtrip"
    :entries {:assets []
              :components []
              :screens ["screens/roundtrip.json"]
              :tokens []}
    :name "SmallPen Round Trip"
    :packageId "pkg_roundtrip"}
   :locator "/tmp/roundtrip.smallpen"
   :revision "revision-1"
   :runtime
   {:components {}
    :file (str file-id)
    :nodes {:scr_roundtrip
            {:pres_desktop
             {:node_canvas (str canvas-id)
              :node_rectangle (str rectangle-id)}}}
    :pages {:scr_roundtrip
            {:pres_desktop (str page-id)}}
    ;; Canvases as core's runtime lists them (canvases.mjs).
    :canvases [{:id "cnv_pages"
                :name "Round Trip · Desktop"
                :pageId (str page-id)
                :boards [{:screenId "scr_roundtrip" :presentationId "pres_desktop"}]}]
    :project (str project-id)
    :team (str team-id)}})

(t/deftest project-snapshot-preserves-stable-runtime-identities
  (let [{:keys [file]} (projection/project-snapshot
                        snapshot
                        {:file-id file-id :project-id project-id})
        page            (get-in file [:data :pages-index page-id])
        root            (get-in page [:objects uuid/zero])
        canvas          (get-in page [:objects canvas-id])
        rectangle       (get-in page [:objects rectangle-id])
        projected-fields
        {"appliedTokens" nil
         "backgroundBlur" (:background-blur rectangle)
         "blend-mode" (:blend-mode rectangle)
         "blur" (:blur rectangle)
         "children" (:shapes canvas)
         "componentId" nil
         "componentVariantId" nil
         "cornerRadius" ((juxt :r1 :r2 :r3 :r4) rectangle)
         "fills" (:fills rectangle)
         "flipX" nil
         "flipY" nil
         "growType" nil
         "grids" (:grids rectangle)
         "height" (:height rectangle)
         "hide-fill-on-export" (:hide-fill-on-export rectangle)
         "hide-in-viewer" (:hide-in-viewer rectangle)
         "id" (:id rectangle)
         "interactions" (:interactions rectangle)
         "layout" (:layout rectangle)
         "layout-flex-dir" (:layout-flex-dir rectangle)
         "layout-gap-type" (:layout-gap-type rectangle)
         "layout-gap" (:layout-gap rectangle)
         "layout-align-items" (:layout-align-items rectangle)
         "layout-justify-content" (:layout-justify-content rectangle)
         "layout-align-content" (:layout-align-content rectangle)
         "layout-wrap-type" (:layout-wrap-type rectangle)
         "layout-padding-type" (:layout-padding-type rectangle)
         "layout-padding" (:layout-padding rectangle)
         "layout-item-margin" (:layout-item-margin rectangle)
         "layout-item-margin-type" (:layout-item-margin-type rectangle)
         "layout-item-h-sizing" (:layout-item-h-sizing rectangle)
         "layout-item-v-sizing" (:layout-item-v-sizing rectangle)
         "layout-item-max-h" (:layout-item-max-h rectangle)
         "layout-item-min-h" (:layout-item-min-h rectangle)
         "layout-item-max-w" (:layout-item-max-w rectangle)
         "layout-item-min-w" (:layout-item-min-w rectangle)
         "layout-item-align-self" (:layout-item-align-self rectangle)
         "layout-item-absolute" (:layout-item-absolute rectangle)
         "layout-item-z-index" (:layout-item-z-index rectangle)
         "constraints-h" (:constraints-h rectangle)
         "constraints-v" (:constraints-v rectangle)
         "fixed-scroll" (:fixed-scroll rectangle)
         "exports" (:exports rectangle)
         "content" (:content rectangle)
         "pathData" (:path-data rectangle)
         "points" (:points rectangle)
         "locked" (:blocked rectangle)
         "masked-group" (:masked-group rectangle)
         "mediaRef" nil
         "name" (:name rectangle)
         "opacity" (:opacity rectangle)
         "proportionLock" (:proportion-lock rectangle)
         "rotation" nil
         "shadow" (:shadow rectangle)
         "show-content" (:show-content rectangle)
         "sourceNodeId" nil
         "strokes" (:strokes rectangle)
         "text" nil
         "textBlocks" nil
         "textStyle" nil
         "touched" nil
         "type" (:type rectangle)
         "visible" (:hidden rectangle)
         "width" (:width rectangle)
         "x" (:x rectangle)
         "y" (:y rectangle)}
        expected-fields
        {"appliedTokens" nil
         "children" [rectangle-id]
         "componentId" nil
         "cornerRadius" [4 8 12 16]
         "fills" [{:fill-color "#7c3aed" :fill-opacity 0.6}]
         "flipX" nil
         "flipY" nil
         "growType" nil
         "height" 120
         "id" rectangle-id
         "interactions" []
         "mediaRef" nil
         "name" "Editable Rectangle"
         "opacity" 0.75
         "rotation" nil
         "sourceNodeId" nil
         "strokes" []
         "text" nil
         "textBlocks" nil
         "textStyle" nil
         "touched" nil
         "type" :rect
         "visible" true
         "width" 240
         "x" 80
         "y" 96}]
    (t/is (= file-id (:id file)))
    (t/is (= project-id (:project-id file)))
    (t/is (= :smallpen (:backend file)))
    (t/is (= "Round Trip · Desktop" (:name page)))
    (t/is (= [canvas-id] (:shapes root)))
    (t/is (= :frame (:type canvas)))
    (t/is (= canvas-id (:parent-id rectangle)))
    (t/is (= canvas-id (:frame-id rectangle)))
    (t/is (= (set (:nodeFields projection/format-capabilities))
             (set (keys projected-fields))))
    (doseq [[field expected] expected-fields]
      (t/is (= expected (get projected-fields field))
            (str "projected SmallPen node field: " field)))
    (t/is (= "node_rectangle" (get-in rectangle [:plugin-data :smallpen "node-id"])))
    (t/is (= "revision-1" (get-in file [:data :plugin-data :smallpen "revision"])))))

(t/deftest project-snapshot-materializes-prototype-flows
  (let [snapshot (assoc-in snapshot
                           [:entries "screens/roundtrip.json"
                            :presentations 0 :prototypeFlows]
                           [{:id (str flow-id)
                             :name "Flow 1"
                             :startingNodeId "node_canvas"}])
        page     (-> (projection/project-snapshot
                      snapshot
                      {:file-id file-id :project-id project-id})
                     (get-in [:file :data :pages-index page-id]))]
    (t/is (= {:id flow-id
              :name "Flow 1"
              :starting-frame canvas-id}
             (get-in page [:flows flow-id])))))

(t/deftest project-snapshot-materializes-official-local-editing-attributes
  (let [grid     {:color "#22d3ee"
                  :display true
                  :params {:size 8}
                  :type "square"}
        snapshot (-> snapshot
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :blend-mode]
                               "multiply")
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :grids]
                               [grid])
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :hide-fill-on-export]
                               true)
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :hide-in-viewer]
                               true)
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :masked-group]
                               true)
                     (assoc-in [:entries "screens/roundtrip.json"
                                :presentations 0 :nodes :node_rectangle
                                :show-content]
                               false))
        rectangle (-> (projection/project-snapshot
                       snapshot
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))]
    (t/is (= {:blend-mode :multiply
              :grids [grid]
              :hide-fill-on-export true
              :hide-in-viewer true
              :masked-group true
              :show-content false}
             (select-keys rectangle
                          [:blend-mode
                           :grids
                           :hide-fill-on-export
                           :hide-in-viewer
                           :masked-group
                           :show-content])))))

(t/deftest project-snapshot-rejects-a-capability-contract-mismatch
  (t/is (thrown-with-msg?
         js/Error
         #"capabilit"
         (projection/project-snapshot
          (assoc-in snapshot
                    [:formatCapabilities :webProjection :nodeTypes]
                    ["FRAME" "RECTANGLE" "TEXT" "ELLIPSE"])
          {:file-id file-id :project-id project-id}))))

(t/deftest project-snapshot-materializes-components-and-copy-source-chains
  (let [component-stable-id "cmp_button"
        main-stable-id      "node_component_main"
        main-child-stable-id "node_component_child"
        instance-stable-id  "node_instance"
        copy-child-stable-id "node_instance_child"
        component-entry
        {:id component-stable-id
         :mainNodeId main-stable-id
         :name "Button"
         :path "Controls"
         :presentationId "pres_desktop"
         :screenId "scr_roundtrip"}
        component-main
        {:children [main-child-stable-id]
         :componentId component-stable-id
         :height 80
         :id main-stable-id
         :name "Button"
         :type "COMPONENT"
         :width 160
         :x 360
         :y 96}
        component-child
        {:children []
         :fills [{:color "#2563eb" :type "solid"}]
         :height 32
         :id main-child-stable-id
         :name "Label background"
         :type "RECTANGLE"
         :width 120
         ;; Parent-relative: 20,24 inside the main at 360,96.
         :x 20
         :y 24}
        instance
        {:children [copy-child-stable-id]
         :componentId component-stable-id
         :height 80
         :id instance-stable-id
         :name "Button instance"
         :sourceNodeId main-stable-id
         :type "INSTANCE"
         :width 160
         :x 560
         :y 96}
        copy-child
        {:children []
         :fills [{:color "#dc2626" :type "solid"}]
         :height 32
         :id copy-child-stable-id
         :name "Label background"
         :sourceNodeId main-child-stable-id
         :touched ["fill-group"]
         :type "RECTANGLE"
         :width 120
         :x 20
         :y 24}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :components]
                      ["components/button.json"])
            (assoc-in [:entries "components/button.json"] component-entry)
            (update-in [:entries "screens/roundtrip.json"
                        :presentations 0 :nodes :node_canvas :children]
                       into
                       [main-stable-id instance-stable-id])
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword main-stable-id)]
                      component-main)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword main-child-stable-id)]
                      component-child)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword instance-stable-id)]
                      instance)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword copy-child-stable-id)]
                      copy-child)
            (assoc-in [:runtime :components component-stable-id]
                      (str component-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword main-stable-id)]
                      (str component-main-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword main-child-stable-id)]
                      (str component-child-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword instance-stable-id)]
                      (str instance-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword copy-child-stable-id)]
                      (str instance-child-id)))
        file      (:file (projection/project-snapshot
                          candidate
                          {:file-id file-id :project-id project-id}))
        component (get-in file [:data :components component-id])
        main      (get-in file [:data :pages-index page-id
                                :objects component-main-id])
        copy      (get-in file [:data :pages-index page-id
                                :objects instance-id])
        copy-child (get-in file [:data :pages-index page-id
                                 :objects instance-child-id])
        main-child (get-in file [:data :pages-index page-id
                                 :objects component-child-id])]
    ;; Penpot shapes are absolute: each child adds its parent's origin.
    (t/is (= [380 120] [(:x main-child) (:y main-child)]))
    (t/is (= [580 120] [(:x copy-child) (:y copy-child)]))
    (t/is (= {:id component-id
              :main-instance-id component-main-id
              :main-instance-page page-id
              :name "Button"
              :path "Controls"}
             component))
    (t/is (= component-id (:component-id main)))
    (t/is (= file-id (:component-file main)))
    (t/is (true? (:component-root main)))
    (t/is (true? (:main-instance main)))
    (t/is (= component-id (:component-id copy)))
    (t/is (= component-main-id (:shape-ref copy)))
    (t/is (true? (:component-root copy)))
    (t/is (= component-child-id (:shape-ref copy-child)))
    (t/is (= #{:fill-group} (:touched copy-child)))
    ;; A main and a copy are boards: their children are framed by them, so
    ;; Penpot pins unconstrained children left/top when a copy is resized
    ;; instead of scaling them as a group's.
    (t/is (= component-main-id (:frame-id main-child)))
    (t/is (= instance-id (:frame-id copy-child)))
    ;; Neither the main nor its copy paints Penpot's white board default.
    (t/is (= [] (:fills main)))
    (t/is (= [] (:fills copy)))
    ;; Nested boards are not View mode screens; the screen root is.
    (t/is (true? (:hide-in-viewer main)))
    (t/is (true? (:hide-in-viewer copy)))
    (t/is (nil? (get-in file [:data :pages-index page-id
                              :objects canvas-id :hide-in-viewer])))))

(t/deftest shapes-without-fills-project-without-penpot-default-fills
  (let [nodes     [:entries "screens/roundtrip.json" :presentations 0 :nodes]
        candidate (-> snapshot
                      (assoc-in (conj nodes :node_rectangle :fills) [])
                      (update-in (conj nodes :node_canvas) dissoc :fills))
        objects   (get-in (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id})
                          [:file :data :pages-index page-id :objects])]
    ;; A removed fill stays removed after a reload instead of coming back
    ;; as Penpot's grey shape default.
    (t/is (= [] (:fills (get objects rectangle-id))))
    ;; The screen root keeps the white board both renderers draw.
    (t/is (= ["#FFFFFF"] (mapv :fill-color (:fills (get objects canvas-id)))))))

(t/deftest absolute-origins-accumulate-every-ancestor-offset
  (let [nodes   {:frame {:children ["group"] :id "frame" :x 100 :y 50}
                 :group {:children ["leaf"] :id "group" :x 10 :y 20}
                 :leaf  {:children [] :id "leaf" :x 5 :y 7}}
        origins (#'projection/absolute-origins nodes ["frame"])]
    (t/is (= (gmt/matrix 1 0 0 1 100 50) (get-in origins ["frame" :matrix])))
    (t/is (= (gmt/matrix 1 0 0 1 110 70) (get-in origins ["group" :matrix])))
    (t/is (= (gmt/matrix 1 0 0 1 115 77) (get-in origins ["leaf" :matrix])))
    (t/is (= (gmt/matrix 1 0 0 1 125 87)
             (get-in (#'projection/absolute-origins nodes ["frame"] 10 10)
                     ["leaf" :matrix])))))

(t/deftest component-grid-tracks-fit-their-largest-variant
  (let [variant    (fn [id width height]
                     {:id id
                      :rootId "root"
                      :nodes {:root {:height height :id "root" :width width}}})
        ;; Seven variants: six fill the first row, the seventh opens row two.
        sizes      [[400 50] [100 300] [10 10] [10 10] [10 10] [10 10] [30 20]]
        placements (#'projection/variant-placements
                    {"cmp_a" {:variants (map-indexed (fn [index [width height]]
                                                       (variant (str "v" index) width height))
                                                     sizes)}})]
    (t/is (= [[0 0] [480 0] [660 0] [750 0] [840 0] [930 0] [0 380]]
             (mapv (juxt :offset-x :offset-y) placements)))))

(t/deftest token-sets-keep-the-canonical-token-order
  (let [names    (mapv #(str "space." (char (+ 97 %))) (range 12))
        ids      (mapv #(str "tok_" %) (range 12))
        library  {:activeSetIds ["set_core"]
                  :activeThemeIds []
                  :sets [{:id "set_core"
                          :name "core"
                          :tokens (mapv (fn [id name]
                                          {:id id :name name :type "spacing" :value 4})
                                        (rseq ids)
                                        (rseq names))}]
                  :themes []}
        set-id   (uuid/next)
        runtime  (-> {:tokenSets {"set_core" (str set-id)}}
                     (assoc :tokens (zipmap ids (repeatedly #(str (uuid/next))))))
        lib      (#'projection/project-token-library {:runtime runtime} library)]
    (t/is (= (vec (rseq names))
             (vec (keys (ctob/get-tokens lib set-id)))))))

(t/deftest project-snapshot-preserves-an-external-component-source-chain
  (let [component-stable-id "cmp_shared_button"
        main-stable-id "node_shared_component_main"
        child-stable-id "node_shared_component_child"
        instance-stable-id "node_instance"
        copy-child-stable-id "node_instance_child"
        library
        (-> snapshot
            (assoc-in [:manifest :packageId] "pkg_shared_components")
            (assoc-in [:manifest :entries :components]
                      ["components/button.json"])
            (assoc-in [:entries "components/button.json"]
                      {:id component-stable-id
                       :mainNodeId main-stable-id
                       :name "Button"
                       :path "Controls"
                       :presentationId "pres_desktop"
                       :screenId "scr_roundtrip"})
            (assoc-in [:runtime :file] (str external-file-id))
            (assoc-in [:runtime :components component-stable-id]
                      (str component-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword main-stable-id)]
                      (str component-main-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword child-stable-id)]
                      (str component-child-id)))
        component-reference {:assetId component-stable-id
                             :packageId "pkg_shared_components"}
        candidate
        (-> snapshot
            (update-in [:entries "screens/roundtrip.json"
                        :presentations 0 :nodes :node_canvas :children]
                       into
                       [instance-stable-id])
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword instance-stable-id)]
                      {:children [copy-child-stable-id]
                       :componentId component-reference
                       :height 80
                       :id instance-stable-id
                       :name "Shared Button instance"
                       :sourceNodeId main-stable-id
                       :type "INSTANCE"
                       :width 160
                       :x 560
                       :y 96})
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes (keyword copy-child-stable-id)]
                      {:children []
                       :fills [{:color "#dc2626" :type "solid"}]
                       :height 32
                       :id copy-child-stable-id
                       :name "Label background"
                       :sourceNodeId child-stable-id
                       :touched ["fill-group"]
                       :type "RECTANGLE"
                       :width 120
                       :x 580
                       :y 120})
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword instance-stable-id)]
                      (str instance-id))
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop
                       (keyword copy-child-stable-id)]
                      (str instance-child-id)))
        file (:file (projection/project-snapshot
                     candidate
                     {:file-id file-id
                      :libraries [library]
                      :project-id project-id}))
        copy (get-in file [:data :pages-index page-id :objects instance-id])
        copy-child (get-in file [:data :pages-index page-id
                                 :objects instance-child-id])]
    (t/is (= component-id (:component-id copy)))
    (t/is (= external-file-id (:component-file copy)))
    (t/is (= component-main-id (:shape-ref copy)))
    (t/is (= component-child-id (:shape-ref copy-child)))
    (t/is (= #{:fill-group} (:touched copy-child)))
    ;; A copy of a Library component is a board too.
    (t/is (= instance-id (:frame-id copy-child)))))

(t/deftest project-snapshot-materializes-token-library-and-applied-token-names
  (let [set-stable-id "tset_core"
        color-stable-id "tok_color_primary"
        sizing-stable-id "tok_size_card"
        theme-stable-id "theme_light"
        token-entry
        {:activeSetIds [set-stable-id]
         :activeThemeIds [theme-stable-id]
         :id "tlib_design"
         :sets [{:description "Product defaults"
                 :id set-stable-id
                 :name "core"
                 :tokens [{:description "Brand color"
                           :id color-stable-id
                           :name "color.primary"
                           :type "color"
                           :value "#2563eb"}
                          {:description "Card width"
                           :id sizing-stable-id
                           :name "size.card"
                           :type "sizing"
                           :value 240}]}]
         :themes [{:description "Light product theme"
                   :externalId "smallpen-light"
                   :group "Product"
                   :id theme-stable-id
                   :isSource false
                   :name "Light"
                   :setIds [set-stable-id]}]}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :tokens] ["tokens/design.json"])
            (assoc-in [:entries "tokens/design.json"] token-entry)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes :node_rectangle
                       :appliedTokens]
                      {:fill "color.primary" :width "size.card"})
            (assoc-in [:runtime :tokenSets set-stable-id]
                      (str token-set-id))
            (assoc-in [:runtime :tokens color-stable-id]
                      (str color-token-id))
            (assoc-in [:runtime :tokens sizing-stable-id]
                      (str sizing-token-id))
            (assoc-in [:runtime :tokenThemes theme-stable-id]
                      (str token-theme-id)))
        file       (:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        tokens-lib (get-in file [:data :tokens-lib])
        token-set  (ctob/get-set tokens-lib token-set-id)
        color      (ctob/get-token tokens-lib token-set-id color-token-id)
        theme      (ctob/get-theme tokens-lib token-theme-id)
        hidden     (ctob/get-theme tokens-lib uuid/zero)
        rectangle  (get-in file [:data :pages-index page-id
                                 :objects rectangle-id])]
    (t/is (= "core" (ctob/get-name token-set)))
    (t/is (= "color.primary" (:name color)))
    (t/is (= :color (:type color)))
    (t/is (= "#2563eb" (:value color)))
    (t/is (= #{"core"} (:sets theme)))
    (t/is (= #{"core"} (:sets hidden)))
    (t/is (= #{(ctob/get-theme-path theme)}
             (spts/get-active-theme-paths tokens-lib)))
    (t/is (= {:fill "color.primary" :width "size.card"}
             (:applied-tokens rectangle)))))

(t/deftest project-snapshot-shows-the-applied-tokens-the-background-computed
  ;; The Background computes applied Tokens from the bindings with core's one
  ;; table (token-attributes.mjs); the App shows them as they come.
  (let [objects (-> snapshot
                    (assoc-in [:entries "screens/roundtrip.json" :presentations 0
                               :nodes :node_rectangle :penpotAppliedTokens]
                              {:fill "color.brand" :r1 "radius.lg" :m4 "space.4"})
                    (projection/project-snapshot {:file-id file-id :project-id project-id})
                    (get-in [:file :data :pages-index page-id :objects]))]
    (t/is (= {:fill "color.brand" :r1 "radius.lg" :m4 "space.4"}
             (get-in objects [rectangle-id :applied-tokens])))))

;; View mode pages through the boards Penpot does not hide. A board drawn
;; inside a board is hidden there, so a one-board screen is one viewer
;; page; an explicit Package value wins, and a nested board an interaction
;; navigates to stays a screen.
(t/deftest nested-boards-are-hidden-in-view-mode
  (let [nodes     [:entries "screens/roundtrip.json" :presentations 0 :nodes]
        runtime   [:runtime :nodes :scr_roundtrip :pres_desktop]
        board     (fn [id x]
                    {:children [] :height 40 :id id :name id
                     :type "FRAME" :width 40 :x x :y 0})
        shown-id  #uuid "a1a1a1a1-0000-4000-8000-000000000001"
        target-id #uuid "a1a1a1a1-0000-4000-8000-000000000002"
        candidate (-> snapshot
                      (update-in (conj nodes :node_canvas :children)
                                 into ["node_shown" "node_target"])
                      (assoc-in (conj nodes :node_shown)
                                (assoc (board "node_shown" 0)
                                       :hide-in-viewer false))
                      (assoc-in (conj nodes :node_target)
                                (board "node_target" 60))
                      (assoc-in (conj nodes :node_rectangle :interactions)
                                [{:action-type "navigate"
                                  :destination (str target-id)
                                  :event-type "click"}])
                      (assoc-in (conj runtime :node_shown) (str shown-id))
                      (assoc-in (conj runtime :node_target) (str target-id)))
        objects   (get-in (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id})
                          [:file :data :pages-index page-id :objects])
        plain     (get-in (projection/project-snapshot
                           (update-in candidate (conj nodes :node_rectangle)
                                      dissoc :interactions)
                           {:file-id file-id :project-id project-id})
                          [:file :data :pages-index page-id :objects])]
    (t/is (nil? (:hide-in-viewer (get objects canvas-id))))
    (t/is (false? (:hide-in-viewer (get objects shown-id))))
    (t/is (nil? (:hide-in-viewer (get objects target-id))))
    (t/is (true? (:hide-in-viewer (get plain target-id))))
    ;; Only boards: a rectangle has no viewer page to hide.
    (t/is (nil? (:hide-in-viewer (get objects rectangle-id))))
    (t/is (= #{canvas-id shown-id target-id}
             (set (map :id (ctst/get-viewer-frames objects)))))
    (t/is (= #{canvas-id shown-id}
             (set (map :id (ctst/get-viewer-frames plain)))))))

;; Package shadows come as DTCG objects (offsetX/offsetY, or x/y in older
;; Packages) or as the native records Penpot edits saved; every one reaches
;; the shape as a valid native shadow, and anything else fails.
(t/deftest project-snapshot-converts-every-stored-shadow-form
  (let [shadow-of (fn [shadow]
                    (-> (assoc-in snapshot
                                  [:entries "screens/roundtrip.json"
                                   :presentations 0 :nodes :node_rectangle
                                   :shadow]
                                  shadow)
                        (projection/project-snapshot
                         {:file-id file-id :project-id project-id})
                        (get-in [:file :data :pages-index page-id
                                 :objects rectangle-id :shadow])))
        legacy    (shadow-of [{:blur 12 :color "#10182826" :spread 0
                               :x 0 :y 4}])
        inset     (shadow-of {:blur "2px" :color "#000000" :inset true
                              :offsetX "1" :offsetY 0 :spread 0})
        native    (shadow-of [{:blur 4
                               :color {:color "#000000" :opacity 0.2}
                               :hidden false
                               :id "shadow"
                               :offset-x 4
                               :offset-y 4
                               :spread 0
                               :style "drop-shadow"}])]
    (t/is (every? ctss/valid-shadow? (concat legacy inset native)))
    (t/is (= [{:id nil :style :drop-shadow :hidden false :blur 12
               :offset-x 0 :offset-y 4 :spread 0
               :color {:color "#101828" :opacity (/ 0x26 255)}}]
             legacy))
    (t/is (= [:inner-shadow 1 2] ((juxt :style :offset-x :blur) (first inset))))
    (t/is (= [{:id nil :style :drop-shadow :hidden false :blur 4
               :offset-x 4 :offset-y 4 :spread 0
               :color {:color "#000000" :opacity 0.2}}]
             native))
    (t/is (thrown-with-msg? js/Error #"unsupported SmallPen shadow"
                            (shadow-of [{:depth 3}])))
    (t/is (thrown-with-msg? js/Error #"unsupported SmallPen shadow"
                            (shadow-of [{:blur "wide" :color "#000000"}])))))

;; A Product's token manager holds its Foundation's sets and themes first,
;; then its own, with the Product's selection of the Foundation's themes
;; (docs/TOKEN-THEMES.md 5); a name in a later active set wins.
(defn- foundation-themes-fixture
  [dependency]
  (let [foundation
        {:manifest {:packageId "pkg_fnd"
                    :entries {:tokens ["tokens/fnd.json"]}}
         :entries {"tokens/fnd.json"
                   {:activeSetIds ["tset_base"]
                    :activeThemeIds ["theme_light"]
                    :sets [{:id "tset_base" :name "base"
                            :tokens [{:id "tok_brand" :name "color.brand"
                                      :type "color" :value "#6750a4"}]}
                           {:id "tset_light" :name "theme/light" :tokens []}
                           {:id "tset_dark" :name "theme/dark"
                            :tokens [{:id "tok_brand_dark" :name "color.brand"
                                      :type "color" :value "#d0bcff"}]}]
                    :themes [{:group "Theme" :id "theme_light" :name "Light"
                              :setIds ["tset_base" "tset_light"]}
                             {:group "Theme" :id "theme_dark" :name "Dark"
                              :setIds ["tset_base" "tset_dark"]}]}}
         :runtime {:file (str (uuid/next))
                   :tokenSets {"tset_base" (str (uuid/next))
                               "tset_light" (str (uuid/next))
                               "tset_dark" (str (uuid/next))}
                   :tokenThemes {"theme_light" (str (uuid/next))
                                 "theme_dark" (str (uuid/next))}
                   :tokens {"tok_brand" (str (uuid/next))
                            "tok_brand_dark" (str (uuid/next))}}}
        product
        (-> snapshot
            (assoc-in [:manifest :dependencies] [dependency])
            (assoc-in [:manifest :entries :tokens] ["tokens/product.json"])
            (assoc-in [:entries "tokens/product.json"]
                      {:activeSetIds ["tset_product"]
                       :activeThemeIds []
                       :sets [{:id "tset_product" :name "product"
                               :tokens [{:id "tok_gap" :name "spacing.gap"
                                         :type "spacing" :value 8}]}]
                       :themes []})
            (assoc-in [:runtime :tokenSets "tset_product"] (str token-set-id))
            (assoc-in [:runtime :tokens "tok_gap"] (str (uuid/next))))]
    [product foundation]))

(defn- projected-token-library
  [product foundation]
  (get-in (projection/project-snapshot
           product
           {:file-id file-id :libraries [foundation] :project-id project-id})
          [:file :data :tokens-lib]))

(defn- active-token-values
  [lib]
  (into {}
        (map (fn [[token-name token]] [token-name (:value token)]))
        (spts/get-tokens-in-active-sets lib)))

(t/deftest product-token-library-holds-the-foundation-sets-and-themes
  (let [[product foundation] (foundation-themes-fixture
                              {:packageId "pkg_fnd"
                               :path "fnd.smallpen"
                               :activeThemeIds ["theme_dark"]})
        lib (projected-token-library product foundation)]
    (t/is (= ["base" "theme/light" "theme/dark" "product"]
             (mapv ctob/get-name (ctob/get-sets lib))))
    (t/is (= #{"Theme/Light" "Theme/Dark"}
             (into #{} (comp (remove ctob/hidden-theme?) (map ctob/get-theme-path))
                   (ctob/get-themes lib))))
    ;; The Product's stored selection decides, and its own active set stays
    ;; on through the hidden theme.
    (t/is (= #{"Theme/Dark" ctob/hidden-theme-path}
             (spts/get-active-theme-paths lib)))
    (t/is (= {"color.brand" "#d0bcff" "spacing.gap" 8}
             (active-token-values lib)))
    (t/is (= (uuid/parse (get-in foundation [:runtime :tokenThemes "theme_dark"]))
             (ctob/get-id (ctob/get-theme-by-path lib "Theme/Dark"))))
    ;; edit_policy refuses edits of these in the Product.
    (t/is (= {:ids (into #{}
                         (map str)
                         (concat (vals (get-in foundation [:runtime :tokenSets]))
                                 (vals (get-in foundation [:runtime :tokenThemes]))
                                 (vals (get-in foundation [:runtime :tokens]))))
              :sets ["base" "theme/light" "theme/dark"]}
             (-> (projection/project-snapshot
                  product
                  {:file-id file-id :libraries [foundation] :project-id project-id})
                 (get-in [:file :data :plugin-data :smallpen "foundation-tokens"])
                 (js/JSON.parse)
                 (js->clj :keywordize-keys true)
                 (update :ids set))))))

(t/deftest product-token-selection-falls-back-to-the-foundation
  (let [[product foundation] (foundation-themes-fixture
                              {:packageId "pkg_fnd" :path "fnd.smallpen"})]
    ;; No stored selection: the Foundation's own active themes apply.
    (t/is (= "#6750a4"
             (get (active-token-values (projected-token-library product foundation))
                  "color.brand")))
    ;; The Background's rows (core listTokenThemes) win when present.
    (t/is (= "#d0bcff"
             (get (active-token-values
                   (projected-token-library
                    (assoc product :tokenThemes
                           [{:active false :id "theme_light" :owner "foundation"
                             :packageId "pkg_fnd" :path "Theme/Light"}
                            {:active true :id "theme_dark" :owner "foundation"
                             :packageId "pkg_fnd" :path "Theme/Dark"}])
                    foundation))
                  "color.brand")))
    (t/is (thrown-with-msg?
           js/Error #"collide"
           (projected-token-library
            (assoc-in product [:entries "tokens/product.json" :sets 0 :name] "base")
            foundation)))))

;; Penpot resolves a shadow Token only in its own form (a vector of shadows
;; with string lengths); a bound shadow resolves to the DTCG object, which a
;; Penpot shape holds as a native shadow record.
(t/deftest project-snapshot-projects-shadow-tokens-and-bound-shadows
  (let [shadow-token-id #uuid "abababab-1111-4111-8111-111111111111"
        dtcg-shadow     {:blur 4
                         :color "rgba(0, 0, 0, 0.24)"
                         :offsetX 0
                         :offsetY 2
                         :spread 0}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :tokens] ["tokens/design.json"])
            (assoc-in [:entries "tokens/design.json"]
                      {:activeSetIds ["tset_core"]
                       :activeThemeIds []
                       :id "tlib_design"
                       :sets [{:description ""
                               :id "tset_core"
                               :name "core"
                               :tokens [{:description ""
                                         :id "tok_elevation"
                                         :name "elevation-1"
                                         :type "shadow"
                                         :value dtcg-shadow}]}]
                       :themes []})
            (assoc-in [:runtime :tokenSets "tset_core"] (str token-set-id))
            (assoc-in [:runtime :tokens "tok_elevation"] (str shadow-token-id))
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes :node_rectangle]
                      {:children []
                       :fills [{:color "#7c3aed" :type "solid"}]
                       :height 120
                       :id "node_rectangle"
                       :name "Editable Rectangle"
                       :shadow dtcg-shadow
                       :tokenBindings {:shadow {:assetId "tok_elevation"
                                                :packageId "pkg_roundtrip"}}
                       :type "RECTANGLE"
                       :width 240
                       :x 80
                       :y 96}))
        file       (:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        token      (ctob/get-token (get-in file [:data :tokens-lib])
                                   token-set-id
                                   shadow-token-id)
        rectangle  (get-in file [:data :pages-index page-id
                                 :objects rectangle-id])
        [record]   (:shadow rectangle)]
    (t/is (= [{:offset-x "0" :offset-y "2" :blur "4" :spread "0"
               :color "rgba(0, 0, 0, 0.24)" :inset false}]
             (:value token)))
    (t/is (= 1 (count (:shadow rectangle))))
    (t/is (ctss/valid-shadow? record))
    (t/is (= 2 (:offset-y record)))))

(t/deftest project-snapshot-materializes-dtcg-tokens-in-one-active-set
  (let [candidate
        (-> snapshot
            (assoc-in [:manifest :entries :tokens]
                      ["tokens/foundation.json"])
            (assoc-in [:entries "tokens/foundation.json"]
                      {:color
                       {:brand
                        {:$extensions {:smallpen {:id "tok_brand"
                                                  :visibility "public"}}
                         :$type "color"
                         :$value "#6750a4"}}})
            (assoc-in [:runtime :dtcgTokenSet] (str dtcg-token-set-id))
            (assoc-in [:runtime :tokenSets "smallpen:dtcg"]
                      (str dtcg-token-set-id))
            (assoc-in [:runtime :tokens "tok_brand"]
                      (str dtcg-token-id)))
        file       (:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        tokens-lib (get-in file [:data :tokens-lib])
        active     (spts/get-tokens-in-active-sets tokens-lib)
        token      (get active "color.brand")]
    (t/is (= 1 (count (ctob/get-sets tokens-lib))))
    (t/is (= :color (:type token)))
    (t/is (= "#6750a4" (:value token)))
    (t/is (= dtcg-token-id (:id token)))))

(t/deftest project-snapshot-materializes-local-assets-and-shape-references
  (let [color-stable-id "color_primary"
        typography-stable-id "typo_body"
        asset-entry
        {:colors [{:id color-stable-id
                   :name "Primary"
                   :paint {:color "#2563eb" :opacity 0.8 :type "solid"}
                   :path "Brand"}]
         :fonts []
         :id "alib_design"
         :media []
         :typographies
         [{:id typography-stable-id
           :name "Body"
           :path "Text"
           :style {:fontFamily "Inter"
                   :fontId "gfont-inter"
                   :fontSize 16
                   :fontStyle "normal"
                   :fontVariantId "regular"
                   :fontWeight 400
                   :letterSpacing 0
                   :lineHeight 1.4
                   :textTransform "none"}}]}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :assets] ["assets/design.json"])
            (assoc-in [:entries "assets/design.json"] asset-entry)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes :node_rectangle]
                      {:children []
                       :fills [{:color "#2563eb"
                                :colorRef color-stable-id
                                :opacity 0.8
                                :type "solid"}]
                       :growType "fixed"
                       :height 48
                       :id "node_rectangle"
                       :name "Referenced text"
                       :strokes [{:color "#2563eb"
                                  :colorRef color-stable-id
                                  :type "solid"
                                  :width 2}]
                       :text "Hello"
                       :textStyle {:typographyRef typography-stable-id}
                       :type "TEXT"
                       :width 240
                       :x 80
                       :y 96})
            (assoc-in [:runtime :colors color-stable-id]
                      (str library-color-id))
            (assoc-in [:runtime :typographies typography-stable-id]
                      (str library-typography-id)))
        file       (:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        color      (get-in file [:data :colors library-color-id])
        typography (get-in file [:data :typographies library-typography-id])
        shape      (get-in file [:data :pages-index page-id
                                 :objects rectangle-id])
        span       (get-in shape [:content :children 0 :children 0
                                  :children 0])]
    (t/is (= {:color "#2563eb"
              :id library-color-id
              :name "Primary"
              :opacity 0.8
              :path "Brand"}
             color))
    (t/is (= "Inter" (:font-family typography)))
    (t/is (= "16" (:font-size typography)))
    (t/is (= "1.4" (:line-height typography)))
    (t/is (= file-id (get-in span [:fills 0 :fill-color-ref-file])))
    (t/is (= library-color-id
             (get-in span [:fills 0 :fill-color-ref-id])))
    (t/is (= library-color-id
             (get-in shape [:strokes 0 :stroke-color-ref-id])))
    (t/is (= file-id (:typography-ref-file span)))
    (t/is (= library-typography-id (:typography-ref-id span)))))

(t/deftest project-snapshot-preserves-external-color-and-typography-files
  (let [color-stable-id "color_shared"
        media-stable-id "media_shared"
        typography-stable-id "typo_shared"
        library (-> snapshot
                    (assoc-in [:manifest :packageId] "pkg_shared_library")
                    (assoc-in [:manifest :entries :assets]
                              ["assets/shared.json"])
                    (assoc-in [:entries "assets/shared.json"]
                              {:colors []
                               :fonts []
                               :id "alib_shared"
                               :media [{:blob (str "blobs/"
                                                   (apply str (repeat 64 "a")))
                                        :byteLength 4
                                        :height 24
                                        :id media-stable-id
                                        :mimeType "image/png"
                                        :name "Shared logo"
                                        :path "Brand"
                                        :sha256 (apply str (repeat 64 "a"))
                                        :width 32}]
                               :typographies []})
                    (assoc-in [:runtime :file] (str external-file-id))
                    (assoc-in [:runtime :colors color-stable-id]
                              (str external-color-id))
                    (assoc-in [:runtime :media media-stable-id]
                              (str library-media-id))
                    (assoc-in [:runtime :typographies typography-stable-id]
                              (str external-typography-id)))
        reference {:assetId color-stable-id
                   :packageId "pkg_shared_library"}
        media-reference {:assetId media-stable-id
                         :packageId "pkg_shared_library"}
        candidate
        (assoc-in snapshot
                  [:entries "screens/roundtrip.json"
                   :presentations 0 :nodes :node_rectangle]
                  {:children []
                   :fills [{:color "#2563eb"
                            :colorRef reference
                            :type "solid"}
                           {:mediaRef media-reference
                            :type "image"}]
                   :growType "fixed"
                   :height 48
                   :id "node_rectangle"
                   :name "External references"
                   :strokes [{:color "#2563eb"
                              :colorRef reference
                              :type "solid"
                              :width 2}
                             {:mediaRef media-reference
                              :type "image"
                              :width 1}]
                   :text "Hello"
                   :textStyle
                   {:typographyRef
                    {:assetId typography-stable-id
                     :packageId "pkg_shared_library"}}
                   :type "TEXT"
                   :width 240
                   :x 80
                   :y 96})
        file (:file (projection/project-snapshot
                     candidate
                     {:file-id file-id
                      :libraries [library]
                      :project-id project-id}))
        shape (get-in file [:data :pages-index page-id :objects rectangle-id])
        span (get-in shape [:content :children 0 :children 0 :children 0])]
    (t/is (= external-file-id
             (get-in span [:fills 0 :fill-color-ref-file])))
    (t/is (= external-color-id
             (get-in span [:fills 0 :fill-color-ref-id])))
    (t/is (= library-media-id
             (get-in span [:fills 1 :fill-image :id])))
    (t/is (= external-file-id
             (get-in shape [:strokes 0 :stroke-color-ref-file])))
    (t/is (= external-color-id
             (get-in shape [:strokes 0 :stroke-color-ref-id])))
    (t/is (= library-media-id
             (get-in shape [:strokes 1 :stroke-image :id])))
    (t/is (= external-file-id (:typography-ref-file span)))
    (t/is (= external-typography-id (:typography-ref-id span)))))

(t/deftest project-snapshot-materializes-content-addressed-media
  (let [media-stable-id "media_logo"
        color-stable-id "color_logo"
        asset-entry
        {:colors [{:id color-stable-id
                   :name "Logo image"
                   :paint {:mediaRef media-stable-id :type "image"}
                   :path "Brand"}]
         :fonts []
         :id "alib_media"
         :media [{:blob (str "blobs/" (apply str (repeat 64 "a")))
                  :byteLength 4
                  :height 24
                  :id media-stable-id
                  :mimeType "image/png"
                  :name "Logo"
                  :path "Brand"
                  :sha256 (apply str (repeat 64 "a"))
                  :width 32}]
         :typographies []}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :assets] ["assets/media.json"])
            (assoc-in [:entries "assets/media.json"] asset-entry)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes :node_rectangle]
                      {:children []
                       :fills [{:mediaRef media-stable-id
                                :opacity 0.8
                                :type "image"}]
                       :height 120
                       :id "node_rectangle"
                       :mediaRef media-stable-id
                       :name "Logo"
                       :strokes [{:mediaRef media-stable-id
                                  :type "image"
                                  :width 2}]
                       :type "IMAGE"
                       :width 240
                       :x 80
                       :y 96})
            (assoc-in [:runtime :colors color-stable-id]
                      (str library-color-id))
            (assoc-in [:runtime :media media-stable-id]
                      (str library-media-id))
            (assoc-in [:runtime :mediaStorage media-stable-id]
                      (str library-media-storage-id)))
        file       (:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        media      (get-in file [:data :media library-media-id])
        color      (get-in file [:data :colors library-color-id])
        shape      (get-in file [:data :pages-index page-id
                                 :objects rectangle-id])]
    (t/is (= {:file-id file-id
              :height 24
              :id library-media-id
              :is-local true
              :media-id library-media-storage-id
              :mtype "image/png"
              :name "Logo"
              :path "Brand"
              :width 32}
             media))
    (t/is (= library-media-id (get-in color [:image :id])))
    (t/is (= :image (:type shape)))
    (t/is (= library-media-id (get-in shape [:metadata :id])))
    (t/is (= library-media-id (get-in shape [:fills 0 :fill-image :id])))
    (t/is (= library-media-id
             (get-in shape [:strokes 0 :stroke-image :id])))))

(t/deftest project-snapshot-and-session-materialize-embedded-fonts
  (let [font-stable-id "font_smallpen"
        variant-stable-id "fvar_regular"
        typography-stable-id "typo_offline"
        digest (apply str (repeat 64 "b"))
        font-style {:fontFamily "SmallPen Sans"
                    :fontId font-stable-id
                    :fontSize 18
                    :fontStyle "normal"
                    :fontVariantId "normal-400"
                    :fontWeight 400
                    :letterSpacing 0
                    :lineHeight 1.3
                    :textTransform "none"}
        asset-entry
        {:colors []
         :fonts [{:family "SmallPen Sans"
                  :id font-stable-id
                  :variants [{:files
                              {:woff {:blob (str "blobs/" digest)
                                      :byteLength 8
                                      :mimeType "font/woff"
                                      :sha256 digest}}
                              :id variant-stable-id
                              :name "Regular"
                              :style "normal"
                              :weight 400}]}]
         :id "alib_fonts"
         :media []
         :typographies [{:id typography-stable-id
                         :name "Offline Body"
                         :path "Text"
                         :style font-style}]}
        candidate
        (-> snapshot
            (assoc-in [:manifest :entries :assets] ["assets/fonts.json"])
            (assoc-in [:entries "assets/fonts.json"] asset-entry)
            (assoc-in [:entries "screens/roundtrip.json"
                       :presentations 0 :nodes :node_rectangle]
                      {:children []
                       :growType "fixed"
                       :height 48
                       :id "node_rectangle"
                       :name "Offline text"
                       :text "Embedded"
                       :textStyle font-style
                       :type "TEXT"
                       :width 240
                       :x 80
                       :y 96})
            (assoc-in [:runtime :fonts font-stable-id]
                      (str library-font-id))
            (assoc-in [:runtime :fontVariants variant-stable-id]
                      (str library-font-variant-id))
            (assoc-in [:runtime :fontFiles variant-stable-id "woff"]
                      (str library-font-file-id))
            (assoc-in [:runtime :typographies typography-stable-id]
                      (str library-typography-id)))
        file (:file (projection/project-snapshot
                     candidate
                     {:file-id file-id :project-id project-id}))
        shape (get-in file [:data :pages-index page-id :objects rectangle-id])
        span (get-in shape [:content :children 0 :children 0 :children 0])
        typography (get-in file [:data :typographies library-typography-id])
        variants (session/font-variants candidate)]
    (t/is (= (str "custom-" library-font-id) (:font-id span)))
    (t/is (= (str "custom-" library-font-id) (:font-id typography)))
    (t/is (= [{:id library-font-variant-id
               :team-id session/local-team-id
               :font-id library-font-id
               :font-family "SmallPen Sans"
               :font-weight 400
               :font-style "normal"
               :variant-name "Regular"
               :woff1-file-id library-font-file-id}]
             variants))))

(t/deftest project-snapshot-supports-a-uniform-corner-radius
  (let [candidate (assoc-in snapshot
                            [:entries "screens/roundtrip.json"
                             :presentations 0 :nodes :node_rectangle
                             :cornerRadius]
                            12)
        rectangle (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id :objects rectangle-id]))]
    (t/is (= [12 12 12 12]
             ((juxt :r1 :r2 :r3 :r4) rectangle)))))

(t/deftest project-snapshot-supports-multiple-page-roots
  (let [candidate (-> snapshot
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :rootIds]
                                ["node_canvas" "node_rectangle"])
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_canvas :children]
                                []))
        page      (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id]))
        root      (get-in page [:objects uuid/zero])
        rectangle (get-in page [:objects rectangle-id])]
    (t/is (= [canvas-id rectangle-id] (:shapes root)))
    (t/is (= uuid/zero (:parent-id rectangle)))
    (t/is (= uuid/zero (:frame-id rectangle)))))

(t/deftest project-snapshot-supports-an-empty-page-root
  (let [candidate (-> snapshot
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :rootId]
                                nil)
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :rootIds]
                                [])
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes]
                                {})
                      (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop]
                                {}))
        root      (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects uuid/zero]))]
    (t/is (= [] (:shapes root)))))

(t/deftest project-snapshot-supports-plain-multiline-text
  (let [candidate (assoc-in snapshot
                            [:entries "screens/roundtrip.json"
                             :presentations 0 :nodes :node_rectangle]
                            {:children []
                             :fills [{:color "#2563eb"
                                      :opacity 0.7
                                      :type "solid"}]
                             :growType "auto-height"
                             :height 72
                             :id "node_rectangle"
                             :name "Greeting"
                             :text "Hello 👋\n世界"
                             :textStyle {:fontFamily "Inter"
                                         :fontId "gfont-inter"
                                         :fontSize 18
                                         :fontVariantId "600"
                                         :fontWeight 600
                                         :letterSpacing 0.5
                                         :lineHeight 1.4
                                         :textAlign "center"}
                             :type "TEXT"
                             :width 240
                             :x 80
                             :y 96})
        shape     (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))
        content   (:content shape)
        paragraphs (get-in content [:children 0 :children])]
    (t/is (= :text (:type shape)))
    (t/is (= :auto-height (:grow-type shape)))
    (t/is (= "top" (:vertical-align content)))
    (t/is (= ["Hello 👋" "世界"]
             (mapv #(get-in % [:children 0 :text]) paragraphs)))
    (t/is (= "Inter" (get-in paragraphs [0 :children 0 :font-family])))
    (t/is (= "18" (get-in paragraphs [0 :children 0 :font-size])))
    (t/is (= "600" (get-in paragraphs [0 :children 0 :font-weight])))
    (t/is (= "center" (get-in paragraphs [0 :text-align])))
    (t/is (= [{:fill-color "#2563eb" :fill-opacity 0.7}]
             (get-in paragraphs [0 :children 0 :fills])))
    (t/is (nil? (:position-data shape)))))

(t/deftest project-snapshot-uses-the-resolved-built-in-font-family
  (let [candidate (assoc-in snapshot
                            [:entries "screens/roundtrip.json"
                             :presentations 0 :nodes :node_rectangle]
                            {:children []
                             :height 48
                             :id "node_rectangle"
                             :name "Token font override"
                             :text "Resolved family"
                             :textStyle {:fontFamily "Source Sans Pro"
                                         :fontId "inter"
                                         :fontSize 16
                                         :fontStyle "normal"
                                         :fontVariantId "regular"
                                         :fontWeight 700
                                         :letterSpacing 0
                                         :lineHeight 1.2}
                             :type "TEXT"
                             :width 240
                             :x 80
                             :y 96})
        span      (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id :content
                               :children 0 :children 0 :children 0]))]
    (t/is (= "Source Sans Pro" (:font-family span)))
    (t/is (= "sourcesanspro" (:font-id span)))
    (t/is (= "bold" (:font-variant-id span)))))

(t/deftest project-snapshot-supports-rich-text-runs
  (let [candidate (assoc-in snapshot
                            [:entries "screens/roundtrip.json"
                             :presentations 0 :nodes :node_rectangle]
                            {:children []
                             :height 48
                             :id "node_rectangle"
                             :name "Rich greeting"
                             :text "Bold and blue"
                             :textBlocks
                             [{:runs [{:text "Bold"
                                       :textStyle {:fontWeight 700}}
                                      {:text " and "}
                                      {:fills [{:color "#2563eb"
                                                :type "solid"}]
                                       :text "blue"}]}]
                             :type "TEXT"
                             :width 240
                             :x 80
                             :y 96})
        shape     (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))
        runs      (get-in shape [:content :children 0 :children 0 :children])]
    (t/is (= ["Bold" " and " "blue"] (mapv :text runs)))
    (t/is (= "700" (:font-weight (first runs))))
    (t/is (= "bold" (:font-variant-id (first runs))))
    (t/is (= "400" (:font-weight (second runs))))
    (t/is (= "regular" (:font-variant-id (second runs))))
    (t/is (= [{:fill-color "#2563eb" :fill-opacity 1}]
             (:fills (nth runs 2))))))

(t/deftest project-snapshot-supports-gradients-and-strokes
  (let [gradient {:endX 1
                  :endY 1
                  :gradientWidth 1
                  :opacity 0.9
                  :startX 0
                  :startY 0
                  :stops [{:color "#ef4444" :offset 0}
                          {:color "#3b82f6" :offset 1 :opacity 0.8}]
                  :type "linear-gradient"}
        candidate (-> snapshot
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_rectangle :fills]
                                [gradient])
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_rectangle :strokes]
                                [{:alignment "outer"
                                  :color "#0f172a"
                                  :opacity 0.7
                                  :style "dashed"
                                  :type "solid"
                                  :width 3}]))
        shape     (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))]
    (t/is (= :linear (get-in shape [:fills 0 :fill-color-gradient :type])))
    (t/is (= 0.8 (get-in shape [:fills 0 :fill-color-gradient
                                :stops 1 :opacity])))
    (t/is (= :outer (get-in shape [:strokes 0 :stroke-alignment])))
    (t/is (= :dashed (get-in shape [:strokes 0 :stroke-style])))
    (t/is (= "#0f172a" (get-in shape [:strokes 0 :stroke-color])))))

(t/deftest project-snapshot-materializes-rotation-and-flips
  (let [plain     (-> (projection/project-snapshot
                       snapshot
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))
        candidate (-> snapshot
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_rectangle
                                 :flipX]
                                true)
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_rectangle
                                 :rotation]
                                30))
        shape     (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id
                               :objects rectangle-id]))]
    ;; R(30)·diag(-1, 1) about the unchanged center (200, 156).
    (t/is (true? (:flip-x shape)))
    (t/is (= 30 (:rotation shape)))
    (t/is (= (gmt/matrix) (:transform plain)))
    (t/is (close-matrix? (gmt/matrix (- cos30) -0.5 -0.5 cos30 0 0)
                         (:transform shape)))
    (t/is (close-matrix? (gmt/inverse (:transform shape))
                         (:transform-inverse shape)))
    (t/is (= [80 96 240 120] ((juxt :x :y :width :height) (:selrect shape))))
    (t/is (close-points? (corners 200 156 (- cos30) -0.5 -0.5 cos30 120 60)
                         (:points shape)))))

;; Shared geometry fixture: smallpen/test/geometry-roundtrip.test.mjs feeds
;; these exact Penpot values back through the adapter and renders the same
;; tree with render.mjs, so projection, adapter and renderer agree.
;; board  FRAME x100 y100 200x100 rotation 90 -> page p = (250 - y, 50 + x)
;;   child  RECT x10 y20 40x30                -> selrect (195 65), rotation 90
;;   turned RECT x10 y20 40x30 rotation 30    -> selrect (195 65), rotation 120
;;   line   PATH x10 y20 40x30 "M0,0L40,30"   -> content (230 60) (200 100)
;;   group  GROUP x120 y40 60x40 rotation 90
;;     leaf RECT x5 y6 20x10                  -> selrect (195 204), rotation 180
;; mirror FRAME x400 y100 200x100 flipX       -> page p = (600 - x, 100 + y)
;;   mirrored RECT x10 y20 40x30 rotation 30  -> selrect (550 120), rotation
;;                                               330, flip-x
(def geometry-nodes
  {:node_board    {:children ["node_child" "node_turned" "node_line" "node_group"]
                   :height 100 :id "node_board" :name "Board" :rotation 90
                   :type "FRAME" :width 200 :x 100 :y 100}
   :node_child    {:children [] :height 30 :id "node_child" :name "Child"
                   :type "RECTANGLE" :width 40 :x 10 :y 20}
   :node_turned   {:children [] :height 30 :id "node_turned" :name "Turned"
                   :rotation 30 :type "RECTANGLE" :width 40 :x 10 :y 20}
   :node_line     {:children [] :height 30 :id "node_line" :name "Line"
                   :pathData "M0,0L40,30"
                   ;; Stale page-absolute corners an older adapter stored.
                   :points [{:x 999 :y 999} {:x 999 :y 999}
                            {:x 999 :y 999} {:x 999 :y 999}]
                   :type "PATH" :width 40 :x 10 :y 20}
   :node_group    {:children ["node_leaf"] :height 40 :id "node_group"
                   :name "Group" :rotation 90 :type "GROUP" :width 60
                   :x 120 :y 40}
   :node_leaf     {:children [] :height 10 :id "node_leaf" :name "Leaf"
                   :type "RECTANGLE" :width 20 :x 5 :y 6}
   :node_mirror   {:children ["node_mirrored"] :flipX true :height 100
                   :id "node_mirror" :name "Mirror" :type "FRAME" :width 200
                   :x 400 :y 100}
   :node_mirrored {:children [] :height 30 :id "node_mirrored"
                   :name "Mirrored" :rotation 30 :type "RECTANGLE" :width 40
                   :x 10 :y 20}})

(defn- geometry-runtime-id
  [node-key]
  (uuid/custom 0 (hash node-key)))

(defn- geometry-objects
  []
  (let [candidate (reduce
                   (fn [snapshot node-key]
                     (assoc-in snapshot
                               [:runtime :nodes :scr_roundtrip :pres_desktop
                                node-key]
                               (str (geometry-runtime-id node-key))))
                   (-> snapshot
                       (update-in [:entries "screens/roundtrip.json"
                                   :presentations 0 :nodes]
                                  merge geometry-nodes)
                       (update-in [:entries "screens/roundtrip.json"
                                   :presentations 0 :nodes :node_canvas
                                   :children]
                                  conj "node_board" "node_mirror"))
                   (keys geometry-nodes))
        objects   (-> (projection/project-snapshot
                       candidate
                       {:file-id file-id :project-id project-id})
                      (get-in [:file :data :pages-index page-id :objects]))]
    (fn [node-key]
      (get objects (geometry-runtime-id node-key)))))

(t/deftest project-snapshot-composes-a-turned-parent-into-its-children
  (let [shape (geometry-objects)
        board (shape :node_board)
        child (shape :node_child)
        turned (shape :node_turned)]
    (t/is (= [100 100 200 100] ((juxt :x :y :width :height) (:selrect board))))
    (t/is (= 90 (:rotation board)))
    (t/is (= (gmt/matrix 0 1 -1 0 0 0) (:transform board)))
    ;; An unturned child inherits the parent's quarter turn.
    (t/is (= [195 65 40 30] ((juxt :x :y :width :height) (:selrect child))))
    (t/is (= [195 65] ((juxt :x :y) child)))
    (t/is (= 90 (:rotation child)))
    (t/is (= (gmt/matrix 0 1 -1 0 0 0) (:transform child)))
    (t/is (= (gmt/matrix 0 -1 1 0 0 0) (:transform-inverse child)))
    (t/is (= [(gpt/point 230 60) (gpt/point 230 100)
              (gpt/point 200 100) (gpt/point 200 60)]
             (:points child)))
    ;; A turned child adds its own turn about the same center.
    (t/is (= [195 65] ((juxt :x :y) (:selrect turned))))
    (t/is (= 120 (:rotation turned)))
    (t/is (close-matrix? (gmt/matrix -0.5 cos30 (- cos30) -0.5 0 0)
                         (:transform turned)))
    (t/is (close-points? (corners 215 80 -0.5 cos30 (- cos30) -0.5 20 15)
                         (:points turned)))))

(t/deftest project-snapshot-composes-nested-turns-and-mirrors
  (let [shape    (geometry-objects)
        leaf     (shape :node_leaf)
        mirrored (shape :node_mirrored)]
    (t/is (= [195 204 20 10] ((juxt :x :y :width :height) (:selrect leaf))))
    (t/is (= 180 (:rotation leaf)))
    (t/is (= (gmt/matrix -1 0 0 -1 0 0) (:transform leaf)))
    (t/is (= [(gpt/point 215 214) (gpt/point 195 214)
              (gpt/point 195 204) (gpt/point 215 204)]
             (:points leaf)))
    ;; A mirrored parent turns its children the other way: diag(-1, 1)·R(30)
    ;; = R(330)·diag(-1, 1).
    (t/is (= [550 120 40 30] ((juxt :x :y :width :height) (:selrect mirrored))))
    (t/is (true? (:flip-x mirrored)))
    (t/is (not (:flip-y mirrored)))
    (t/is (= 330 (:rotation mirrored)))
    (t/is (close-matrix? (gmt/matrix (- cos30) 0.5 0.5 cos30 0 0)
                         (:transform mirrored)))
    (t/is (close-points? (corners 570 135 (- cos30) 0.5 0.5 cos30 20 15)
                         (:points mirrored)))))

(t/deftest project-snapshot-maps-path-content-through-the-parent-turn
  (let [line ((geometry-objects) :node_line)]
    (t/is (= :path (:type line)))
    (t/is (= [(gpt/point 230 60) (gpt/point 200 100)]
             (path/get-points (:content line))))
    (t/is (= "M0,0L40,30" (:path-data line)))
    (t/is (= [195 65 40 30] ((juxt :x :y :width :height) (:selrect line))))
    (t/is (= 90 (:rotation line)))
    ;; Stored page-absolute points are ignored; corners follow the content.
    (t/is (= [(gpt/point 230 60) (gpt/point 230 100)
              (gpt/point 200 100) (gpt/point 200 60)]
             (:points line)))))

(t/deftest project-snapshot-materializes-ellipse-group-and-path-nodes
  (let [group-runtime-id   #uuid "16161616-1616-4616-8616-161616161616"
        ellipse-runtime-id #uuid "17171717-1717-4717-8717-171717171717"
        path-runtime-id    #uuid "18181818-1818-4818-8818-181818181818"
        nodes              {:node_group
                            {:children ["node_ellipse" "node_path"]
                             :height 100
                             :id "node_group"
                             :name "Diagram"
                             :type "GROUP"
                             :width 200
                             :x 20
                             :y 30}
                            :node_ellipse
                            {:children []
                             :height 40
                             :id "node_ellipse"
                             :name "State"
                             :type "ELLIPSE"
                             :width 80
                             :x 30
                             :y 40}
                            :node_path
                            {:children []
                             :height 40
                             :id "node_path"
                             :name "Connector"
                             :pathData "M 110 60 L 190 60"
                             :type "PATH"
                             :width 80
                             :x 110
                             :y 60}}
        candidate          (-> snapshot
                               (update-in [:entries "screens/roundtrip.json"
                                           :presentations 0 :nodes]
                                          merge nodes)
                               (update-in [:entries "screens/roundtrip.json"
                                           :presentations 0 :nodes :node_canvas
                                           :children]
                                          conj "node_group")
                               (assoc-in [:runtime :nodes :scr_roundtrip
                                          :pres_desktop :node_group]
                                         (str group-runtime-id))
                               (assoc-in [:runtime :nodes :scr_roundtrip
                                          :pres_desktop :node_ellipse]
                                         (str ellipse-runtime-id))
                               (assoc-in [:runtime :nodes :scr_roundtrip
                                          :pres_desktop :node_path]
                                         (str path-runtime-id)))
        objects            (-> (projection/project-snapshot
                                candidate
                                {:file-id file-id :project-id project-id})
                               (get-in [:file :data :pages-index page-id
                                        :objects]))]
    (t/is (= :group (get-in objects [group-runtime-id :type])))
    (t/is (= [ellipse-runtime-id path-runtime-id]
             (get-in objects [group-runtime-id :shapes])))
    (t/is (= :circle (get-in objects [ellipse-runtime-id :type])))
    (t/is (= :path (get-in objects [path-runtime-id :type])))
    (t/is (some? (get-in objects [path-runtime-id :content])))))

(t/deftest project-snapshot-rejects-node-types-that-are-not-advertised
  (let [polygon-node {:children []
                      :height 20
                      :id "node_polygon"
                      :name "Polygon"
                      :type "POLYGON"
                      :width 100
                      :x 0
                      :y 0}
        candidate (-> snapshot
                      (assoc-in [:entries "screens/roundtrip.json"
                                 :presentations 0 :nodes :node_polygon]
                                polygon-node)
                      (update-in [:entries "screens/roundtrip.json"
                                  :presentations 0 :nodes :node_canvas :children]
                                 conj "node_polygon")
                      (assoc-in [:runtime :nodes :scr_roundtrip
                                 :pres_desktop :node_polygon]
                                "44444444-4444-4444-8444-444444444444"))]
    (t/is (thrown-with-msg?
           js/Error
           #"unsupported SmallPen node type"
           (projection/project-snapshot
            candidate
            {:file-id file-id :project-id project-id})))))

(t/deftest project-snapshot-rejects-fill-types-that-are-not-advertised
  (let [candidate (assoc-in snapshot
                            [:entries "screens/roundtrip.json"
                             :presentations 0 :nodes :node_rectangle :fills]
                            [{:meshId "mesh_photo" :type "mesh-gradient"}])]
    (t/is (thrown-with-msg?
           js/Error
           #"unsupported SmallPen fill type"
           (projection/project-snapshot
            candidate
            {:file-id file-id :project-id project-id})))))

;; ---------------------------------------------------------------------------
;; DSE-R01/R02 rework (2026-09-15): the generated Design System page must keep
;; one consistent parent/child tree and its specimen grid must not lose
;; specimens on line wrap. Fixtures below mirror the backend's
;; runtime.designSystemRefs payload (package.mjs buildRuntime).
;; ---------------------------------------------------------------------------

(def ds-page-id    #uuid "d5e00000-0000-4000-8000-000000000001")
(def ds-board-id   #uuid "d5e00000-0000-4000-8000-000000000002")
(def ds-label-id   #uuid "d5e00000-0000-4000-8000-000000000003")
(def ds-swatch-id  #uuid "d5e00000-0000-4000-8000-000000000004")
(def ds-sample-id  #uuid "d5e00000-0000-4000-8000-000000000005")
(def components-page-id #uuid "d5e00000-0000-4000-8000-000000000006")
(def variant-cmp-id #uuid "d5e00000-0000-4000-8000-000000000010")
(def sample-root-id #uuid "d5e00000-0000-4000-8000-000000000011")
(def sample-body-id #uuid "d5e00000-0000-4000-8000-000000000012")
(def sample-text-id #uuid "d5e00000-0000-4000-8000-000000000013")
(def specimen-child-a-id #uuid "d5e00000-0000-4000-8000-000000000014")
(def specimen-child-b-id #uuid "d5e00000-0000-4000-8000-000000000015")
(def token-caption-a-id #uuid "d5e00000-0000-4000-8000-000000000016")
(def token-caption-b-id #uuid "d5e00000-0000-4000-8000-000000000017")
(def token-caption-c-id #uuid "d5e00000-0000-4000-8000-000000000018")
(def token-caption-d-id #uuid "d5e00000-0000-4000-8000-000000000019")
(def token-group-a-id #uuid "d5e00000-0000-4000-8000-000000000020")
(def token-group-b-id #uuid "d5e00000-0000-4000-8000-000000000021")
(def page-caption-a-id #uuid "d5e00000-0000-4000-8000-000000000022")
(def page-caption-b-id #uuid "d5e00000-0000-4000-8000-000000000023")
(def located-caption-id #uuid "d5e00000-0000-4000-8000-000000000024")
(def second-page-id #uuid "d5e00000-0000-4000-8000-000000000025")
(def second-canvas-id #uuid "d5e00000-0000-4000-8000-000000000026")
(def second-rectangle-id #uuid "d5e00000-0000-4000-8000-000000000027")
(def located-component-id #uuid "d5e00000-0000-4000-8000-000000000028")
(def tokens-section-id #uuid "d5e00000-0000-4000-8000-000000000029")
(def components-section-id #uuid "d5e00000-0000-4000-8000-000000000030")
(def pages-section-id #uuid "d5e00000-0000-4000-8000-000000000031")
(def token-group-c-id #uuid "d5e00000-0000-4000-8000-000000000032")
(def tokens-empty-id #uuid "d5e00000-0000-4000-8000-000000000033")
(def components-empty-id #uuid "d5e00000-0000-4000-8000-000000000034")
(def pages-empty-id #uuid "d5e00000-0000-4000-8000-000000000035")
(def third-page-id #uuid "d5e00000-0000-4000-8000-000000000036")
(def page-caption-c-id #uuid "d5e00000-0000-4000-8000-000000000037")
(def orphan-root-id #uuid "d5e00000-0000-4000-8000-000000000038")
(def orphan-child-id #uuid "d5e00000-0000-4000-8000-000000000039")
(def token-caption-e-id #uuid "d5e00000-0000-4000-8000-000000000040")
(def token-caption-f-id #uuid "d5e00000-0000-4000-8000-000000000041")

(defn- specimen-shape-id
  "Deterministic runtime id for the n-th fill specimen, mirroring the
  backend's stableRuntimeUuid output slots. Distinct prefix from the
  d5e0... fixture constants above so generated ids never collide."
  [n]
  (let [digits (str n)
        pad    (apply str (repeat (- 12 (count digits)) "0"))]
    (uuid/parse (str "7e57a100-0000-4000-8000-" pad digits))))

(defn- specimen-caption-id
  [n]
  (let [digits (str n)
        pad    (apply str (repeat (- 12 (count digits)) "0"))]
    (str "7e57ca00-0000-4000-8000-" pad digits)))

(defn- fill-specimen-ref
  [n]
  {:attribute "fill"
   :caption (specimen-caption-id n)
   :ownerPackageId "pkg_roundtrip"
   :path (str "color.swatch" n)
   :raw "#2563eb"
   :setId "tset_core"
   :setName "core"
   :shape (str (specimen-shape-id n))
   :tokenId (str "tok_color_swatch" n)
   :type "color"
   :value "#2563eb"})

(def card-set-entry
  {:componentSets
   [{:axes []
     :id "cmp_set_card"
     :name "Card"
     :variants
     [{:id "var_default"
       :name "Default"
       :rootId "node_card_root"
       :selection {}
       :nodes
       {:node_card_root
        {:children ["node_card_body"]
         :height 80
         :id "node_card_root"
         :name "Card root"
         :type "FRAME"
         :width 160
         :x 0
         :y 0}
        :node_card_body
        {:children ["node_card_text"]
         :fills [{:color "#2563eb" :type "solid"}]
         :height 40
         :id "node_card_body"
         :name "Card body"
         :type "RECTANGLE"
         :width 120
         :x 20
         :y 20}
        :node_card_text
        {:children []
         :height 20
         :id "node_card_text"
         :name "Card label"
         :text "Hello"
         :type "TEXT"
         :width 100
         :x 24
         :y 24}}}]}]})

(defn- design-system-snapshot
  "Base snapshot with one Component Set variant (a two-level nested tree) and
  the given token specimens, wired the way the Background runtime does."
  [specimens]
  (-> snapshot
      (assoc-in [:manifest :entries :components] ["components/card.json"])
      (assoc-in [:entries "components/card.json"] card-set-entry)
      (assoc-in [:runtime :variants (keyword "cmp_set_card")
                 (keyword "var_default")]
                (str variant-cmp-id))
      (assoc-in [:runtime :componentNodes (keyword "cmp_set_card")
                 (keyword "var_default")]
                {:node_card_root (str sample-root-id)
                 :node_card_body (str sample-body-id)
                 :node_card_text (str sample-text-id)})
      (assoc-in [:runtime :componentsPage] (str components-page-id))
      (assoc-in [:runtime :designSystemPage] (str ds-page-id))
      (assoc-in [:runtime :designSystem]
                {:board (str ds-board-id)
                 :componentSample (str ds-sample-id)
                 :componentsEmpty (str components-empty-id)
                 :componentsSection (str components-section-id)
                 :pagesEmpty (str pages-empty-id)
                 :pagesSection (str pages-section-id)
                 :tokenLabel (str ds-label-id)
                 :tokenSwatch (str ds-swatch-id)
                 :tokensEmpty (str tokens-empty-id)
                 :tokensSection (str tokens-section-id)})
      (assoc-in [:runtime :designSystemRefs]
                {:componentSample
                 {:componentSetId "cmp_set_card"
                  :kind "component-definition"
                  :ownerPackageId "pkg_roundtrip"
                  :sourceNodeId "node_card_root"
                  :variantId "var_default"}
                 :families
                 [{:caption (str ds-sample-id)
                   :componentSetId "cmp_set_card"
                   :kind "variant"
                   :label "Card"
                   :rootId "node_card_root"
                   :variantId "var_default"}]
                 :specimens specimens})))

(defn- card-sample
  "The Card variant as a core component sample, read from the entries so a
  test's edits to the variant reach it."
  [candidate]
  (let [variant (get-in candidate [:entries "components/card.json" :componentSets 0 :variants 0])]
    {:axes []
     :caption (str ds-sample-id)
     :classification "Composite"
     :componentSetId "cmp_set_card"
     :familyName "Card"
     :kind "variant"
     :nodes (:nodes variant)
     :rootId (:rootId variant)
     :runtimeNodes {:node_card_root (str sample-root-id)
                    :node_card_body (str sample-body-id)
                    :node_card_text (str sample-text-id)}
     :selection {}
     :sources {}
     :variantId (:id variant)
     :variantIndex 0}))

(defn- with-ds-tree
  "The candidate with the page tree the Background serves beside its refs
  (one Card sample unless the refs bring their own)."
  [candidate]
  (let [refs    (get-in candidate [:runtime :designSystemRefs])
        samples (or (:componentSamples refs) [(card-sample candidate)])
        refs    (assoc refs :componentSamples samples)]
    (-> candidate
        (assoc-in [:runtime :designSystemRefs] refs)
        (assoc-in [:runtime :designSystemTree]
                  (ds/ds-tree (str ds-board-id) (:specimens refs) (count samples) (:families refs))))))

(defn- design-system-page
  [candidate]
  (-> (projection/project-snapshot
       (with-ds-tree candidate)
       {:file-id file-id :project-id project-id})
      (get-in [:file :data :pages-index ds-page-id])))

(defn- assert-consistent-shape-tree
  "Every :shapes entry exists, agrees with the child's :parent-id, and each
  shape is listed exactly once by the parent its :parent-id claims. The
  uuid/zero page root is the tree sentinel: it is its own parent by
  convention and is never listed in any :shapes vector."
  [objects]
  (doseq [[id shape] objects
          :let [children (:shapes shape)]]
    (doseq [child-id children]
      (t/is (some? (get objects child-id))
            (str "dangling child reference " child-id " under " id))
      (t/is (= id (:parent-id (get objects child-id)))
            (str "children entry disagrees with parent-id for " child-id))))
  (doseq [[id shape] objects]
    (when-not (= uuid/zero id)
      (let [parent-id (:parent-id shape)]
        (t/is (some? (get objects parent-id))
              (str "missing parent object " parent-id " for " id))
        (t/is (= 1 (count (filter #{id} (:shapes (get objects parent-id)))))
              (str "shape " id " is not listed exactly once by its parent"))))))

;; A variant root without fills paints nothing in the Package renderer; on
;; the Components page it is a main, not a screen board, so it must not get
;; Penpot's white board default either (its copies would differ from it).
(t/deftest variant-roots-without-fills-project-without-a-white-board
  (let [objects (-> (projection/project-snapshot
                     (design-system-snapshot [])
                     {:file-id file-id :project-id project-id})
                    (get-in [:file :data :pages-index components-page-id
                             :objects]))]
    (t/is (= [] (:fills (get objects sample-root-id))))
    (t/is (nil? (:hide-in-viewer (get objects sample-root-id))))))

(t/deftest design-system-page-keeps-one-consistent-parent-child-tree
  (let [specimen-id (specimen-shape-id 1)
        page   (design-system-page
                (design-system-snapshot {"tok_color_primary"
                                         (fill-specimen-ref 1)}))
        objects (:objects page)
        board   (get objects ds-board-id)]
    (t/is (= :frame (:type board)))
    ;; The board lists direct children only, never a sample's descendants,
    ;; so both traversal directions describe the same tree.
    (t/is (some? (get objects specimen-id)))
    (t/is (not-any? #{sample-body-id sample-text-id} (:shapes board)))
    (t/is (= ds-board-id (:parent-id (get objects sample-root-id))))
    (t/is (= sample-root-id (:parent-id (get objects sample-body-id))))
    (t/is (= [sample-body-id] (:shapes (get objects sample-root-id))))
    (t/is (= sample-body-id (:parent-id (get objects sample-text-id))))
    (t/is (= [sample-text-id] (:shapes (get objects sample-body-id))))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-gap-specimen-children-are-listed-once
  (let [ref (assoc (fill-specimen-ref 1)
                   :attribute "gap"
                   :raw 16
                   :type "spacing"
                   :value 16
                   :children [(str specimen-child-a-id)
                              (str specimen-child-b-id)])
        page    (design-system-page
                 (design-system-snapshot {"tok_space_gap" ref}))
        objects (:objects page)
        board   (get objects ds-board-id)
        frame   (get objects (specimen-shape-id 1))]
    (t/is (= :frame (:type frame)))
    (t/is (= {:row-gap 16 :column-gap 16} (:layout-gap frame)))
    ;; The gap frame lists its two fillers exactly once.
    (t/is (= #{specimen-child-a-id specimen-child-b-id} (set (:shapes frame))))
    (t/is (= 2 (count (:shapes frame))))
    (t/is (= (specimen-shape-id 1)
             (:parent-id (get objects specimen-child-a-id))))
    (t/is (= (specimen-shape-id 1)
             (:parent-id (get objects specimen-child-b-id))))
    ;; Fillers belong to their frame, not to the board.
    (t/is (not-any? #{specimen-child-a-id specimen-child-b-id} (:shapes board)))
    (assert-consistent-shape-tree objects)))

;; A page node whose Cell or sample is missing from the refs (a stale tree)
;; draws as a plain decoration or not at all, never failing the file load.
(t/deftest design-system-page-survives-a-stale-tree
  (let [good      (fill-specimen-ref 2)
        candidate (with-ds-tree (design-system-snapshot {"tok_color_swatch2" good}))
        tree      (get-in candidate [:runtime :designSystemTree])
        root      (get-in tree [:nodes (keyword (:rootId tree))])
        stale     (assoc candidate :runtime
                         (-> (:runtime candidate)
                             (assoc-in [:designSystemTree :nodes :node_stale]
                                       {:id "node_stale" :type "RECTANGLE" :name "Stale" :x 0 :y 0
                                        :width 10 :height 10 :children []
                                        :designSystem {:role "token-cell" :specimen "gone"}})
                             (assoc-in [:designSystemTree :nodes :node_lost]
                                       {:id "node_lost" :type "FRAME" :name "Lost" :x 0 :y 0
                                        :width 10 :height 10 :children []
                                        :designSystem {:role "component-sample" :sample 99}})
                             (assoc-in [:designSystemTree :runtimeIds :node_stale] (str (specimen-shape-id 1)))
                             (assoc-in [:designSystemTree :runtimeIds :node_lost] (str (specimen-shape-id 3)))
                             (assoc-in [:designSystemTree :nodes (keyword (:rootId tree)) :children]
                                       (into (:children root) ["node_stale" "node_lost"]))))
        objects   (:objects (get-in (projection/project-snapshot stale {:file-id file-id :project-id project-id})
                                    [:file :data :pages-index ds-page-id]))]
    (t/is (= "decoration" (get-in objects [(specimen-shape-id 1) :plugin-data :smallpen "design-system"])))
    (t/is (nil? (get objects (specimen-shape-id 3))))
    (t/is (= "source" (get-in objects [(specimen-shape-id 2) :plugin-data :smallpen "design-system"])))
    (assert-consistent-shape-tree objects)))

;; The tree carries canonical paints and text; the projection turns them
;; into native ones and marks each specimen with its Cell.
(t/deftest design-system-token-cells-project-canonical-visuals-natively
  (let [alpha-ref      (assoc (fill-specimen-ref 5)
                              :node {:fills [{:color "#336699" :opacity 0.5 :type "solid"}]
                                     :strokes [{:alignment "inner" :color "#64748b" :style "dashed"
                                                :type "solid" :width 1}]})
        typography-ref (assoc (fill-specimen-ref 3)
                              :attribute "typography"
                              :path "heading"
                              :type "typography"
                              :value {:fontFamily "Inter" :fontId "gfont-inter" :fontSize 28
                                      :fontWeight 600 :lineHeight 1.2})
        objects        (:objects (design-system-page
                                  (design-system-snapshot {"alpha" alpha-ref
                                                           "typography" typography-ref})))
        alpha          (get objects (specimen-shape-id 5))
        typography     (get objects (specimen-shape-id 3))
        ref            (js/JSON.parse (get-in alpha [:plugin-data :smallpen "design-system-ref"]))]
    (t/is (= {:fill-color "#336699" :fill-opacity 0.5} (get-in alpha [:fills 0])))
    (t/is (= :dashed (get-in alpha [:strokes 0 :stroke-style])))
    (t/is (= "tok_color_swatch5" (.-tokenId ref)))
    (t/is (= :text (:type typography)))
    (t/is (= "28" (get-in typography [:content :children 0 :children 0 :children 0 :font-size])))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-keeps-located-components-but-excludes-page-previews
  (let [second-presentation
        {:id "pres_mobile"
         :name "Mobile"
         :rootIds ["node_canvas" "node_orphan_root"]
         :nodes
         {:node_canvas {:children ["node_rectangle"]
                        :height 400 :id "node_canvas" :name "Mobile root"
                        :type "FRAME" :width 320 :x 0 :y 0}
          :node_rectangle {:children []
                           :fills [{:color "#22c55e" :type "solid"}]
                           :height 40 :id "node_rectangle" :name "Repeated id"
                           :type "RECTANGLE" :width 100 :x 10 :y 10}
          :node_orphan_root {:children ["node_orphan_child"]
                             :height 80 :id "node_orphan_root" :name "Loose group"
                             :type "GROUP" :width 120 :x 400 :y 0}
          :node_orphan_child {:children []
                              :height 20 :id "node_orphan_child" :name "Loose child"
                              :type "RECTANGLE" :width 40 :x 10 :y 10}}}
        empty-presentation {:id "pres_empty" :name "Empty" :nodes {} :rootIds []}
        located-entry
        {:id "cmp_located"
         :mainNodeId "node_rectangle"
         :name "Located rectangle"
         :presentationId "pres_desktop"
         :screenId "scr_roundtrip"}
        candidate
        (-> (design-system-snapshot {})
            (update-in [:manifest :entries :components] conj "components/located.json")
            (assoc-in [:entries "components/located.json"] located-entry)
            (update-in [:entries "screens/roundtrip.json" :presentations]
                       into [second-presentation empty-presentation])
            (assoc-in [:runtime :components :cmp_located] (str located-component-id))
            (assoc-in [:runtime :pages :scr_roundtrip :pres_mobile] (str second-page-id))
            (assoc-in [:runtime :pages :scr_roundtrip :pres_empty] (str third-page-id))
            (update-in [:runtime :canvases] into
                       [{:id "cnv_mobile" :name "Round Trip · Mobile" :pageId (str second-page-id)
                         :boards [{:screenId "scr_roundtrip" :presentationId "pres_mobile"}]}
                        {:id "cnv_empty" :name "Round Trip · Empty" :pageId (str third-page-id)
                         :boards [{:screenId "scr_roundtrip" :presentationId "pres_empty"}]}])
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_mobile]
                      {:node_canvas (str second-canvas-id)
                       :node_rectangle (str second-rectangle-id)
                       :node_orphan_root (str orphan-root-id)
                       :node_orphan_child (str orphan-child-id)})
            (assoc-in [:runtime :nodes :scr_roundtrip :pres_empty] {})
            (assoc-in [:runtime :designSystemRefs]
                      {:families [{:caption (str located-caption-id)
                                   :componentId "cmp_located"
                                   :kind "located"
                                   :label "Located rectangle with a deliberately very long component family caption"
                                   :mainNodeId "node_rectangle"
                                   :nodeCount 1
                                   :presentationId "pres_desktop"
                                   :screenId "scr_roundtrip"}]
                       :pages [{:caption (str page-caption-a-id)
                                :kind "page" :label "Round Trip · Desktop"
                                :nodeCount 2 :presentationId "pres_desktop"
                                :rootId "node_canvas" :screenId "scr_roundtrip"}
                               {:caption (str page-caption-b-id)
                                :kind "page"
                                :label "Round Trip · Mobile presentation with a deliberately very long page caption"
                                :nodeCount 4 :presentationId "pres_mobile"
                                :rootIds ["node_canvas" "node_orphan_root"]
                                :screenId "scr_roundtrip"}
                               {:caption (str page-caption-c-id)
                                :kind "page" :label "Round Trip · Empty"
                                :nodeCount 0 :presentationId "pres_empty"
                                :rootIds [] :screenId "scr_roundtrip"}]
                       :specimens {}}))
        result (projection/project-snapshot (with-ds-tree candidate) {:file-id file-id :project-id project-id})
        pages (get-in result [:file :data :pages-index])
        objects (get-in pages [ds-page-id :objects])]
    (t/is (some? (get objects rectangle-id)) "located component remains in DS")
    (t/is (some? (get objects located-caption-id)))
    (doseq [id [canvas-id second-canvas-id second-rectangle-id orphan-root-id
                orphan-child-id page-caption-a-id page-caption-b-id page-caption-c-id]]
      (t/is (nil? (get objects id)) "page previews are absent from DS"))
    (t/is (= [second-rectangle-id] (get-in pages [second-page-id :objects second-canvas-id :shapes])))
    (t/is (some? (get-in pages [second-page-id :objects orphan-root-id])))
    (t/is (some? (get pages third-page-id)) "empty real pages are preserved")
    (assert-consistent-shape-tree objects)))

(defn- layout-offset
  [shape]
  (some->> (get-in shape [:plugin-data :smallpen "layout-offset"])
           (re-matches #"(\S+) (\S+)")
           (rest)
           (mapv js/Number)))

;; Generated pages draw copies of source trees elsewhere on the page. Each
;; copy records the shift from its source placement, which a commit sends
;; along so the adapter maps page-absolute geometry back to the source.
(t/deftest generated-page-copies-record-their-layout-offset
  (let [located-entry  {:id "cmp_located"
                        :mainNodeId "node_rectangle"
                        :name "Located rectangle"
                        :presentationId "pres_desktop"
                        :screenId "scr_roundtrip"}
        located-family {:caption (str located-caption-id)
                        :componentId "cmp_located"
                        :kind "located"
                        :label "Located rectangle"
                        :mainNodeId "node_rectangle"
                        :nodeCount 1
                        :presentationId "pres_desktop"
                        :screenId "scr_roundtrip"}
        source-nodes   [:entries "screens/roundtrip.json" :presentations 0 :nodes]
        card-root      [:entries "components/card.json" :componentSets 0
                        :variants 0 :nodes :node_card_root]
        candidate      (-> (design-system-snapshot {})
                           ;; The source node sits inside a moved canvas, so
                           ;; its page placement is not its own x/y.
                           (assoc-in (conj source-nodes :node_canvas :x) 30)
                           (assoc-in (conj source-nodes :node_canvas :y) 50)
                           (assoc-in (conj card-root :x) 7)
                           (assoc-in (conj card-root :y) 9)
                           (update-in [:manifest :entries :components] conj "components/located.json")
                           (assoc-in [:entries "components/located.json"] located-entry)
                           (assoc-in [:runtime :components :cmp_located] (str located-component-id))
                           (update-in [:runtime :designSystemRefs :families] conj located-family))
        pages          (get-in (projection/project-snapshot
                                (with-ds-tree candidate)
                                {:file-id file-id :project-id project-id})
                               [:file :data :pages-index])
        source         (get-in pages [page-id :objects rectangle-id])
        copy           (get-in pages [ds-page-id :objects rectangle-id])]
    (t/is (= [110 146] [(:x source) (:y source)]))
    (t/is (nil? (layout-offset source)) "source pages are not shifted")
    (t/is (= [(- (:x copy) 110) (- (:y copy) 146)] (layout-offset copy)))
    (t/is (not= [0 0] (layout-offset copy)))
    (doseq [page [ds-page-id components-page-id]]
      (let [root (get-in pages [page :objects sample-root-id])
            body (get-in pages [page :objects sample-body-id])]
        (t/is (= [(- (:x root) 7) (- (:y root) 9)] (layout-offset root)))
        (t/is (= (layout-offset root) (layout-offset body))
              "one offset shifts the whole variant tree")))))

(t/deftest design-system-excludes-pages-without-changing-source-geometry
  (doseq [show-content [nil false true]
          panorama? [false true]]
    (let [nodes {:node_canvas
                 (cond-> {:id "node_canvas" :type "FRAME" :name "Canvas"
                          :x 0 :y 0 :width 400 :height 400
                          :children ["node_rectangle"]}
                   (some? show-content) (assoc :show-content show-content))
                 :node_rectangle
                 {:id "node_rectangle" :type "FRAME" :name "Overflow card"
                  :x 200 :y 330 :width 200 :height 120
                  :show-content false :children ["node_nested"]}
                 :node_nested
                 {:id "node_nested" :type "RECTANGLE" :name "Clipped inside card"
                  :x 10 :y 100 :width 40 :height 40 :children []}}
          candidate (-> (design-system-snapshot {})
                        (assoc-in [:entries "screens/roundtrip.json" :presentations 0 :nodes] nodes)
                        (assoc-in [:runtime :nodes :scr_roundtrip :pres_desktop :node_nested]
                                  (str component-child-id))
                        (assoc-in [:runtime :designSystemRefs]
                                  (cond-> {:families [] :specimens {}
                                           :pages [{:caption (str page-caption-a-id)
                                                    :label "Round Trip · Desktop"
                                                    :screenId "scr_roundtrip"
                                                    :presentationId "pres_desktop"
                                                    :rootId "node_canvas"}]}
                                    panorama? (assoc :combinations []))))
          result (projection/project-snapshot (with-ds-tree candidate) {:file-id file-id :project-id project-id})
          pages (get-in result [:file :data :pages-index])
          objects (get-in pages [ds-page-id :objects])
          source-root (get-in pages [page-id :objects canvas-id])
          source-card (get-in pages [page-id :objects rectangle-id])]
      (doseq [id [canvas-id rectangle-id component-child-id page-caption-a-id]]
        (t/is (nil? (get objects id)) "neither legacy nor panorama DS copies pages"))
      (t/is (= [400 400] ((juxt :width :height) source-root)))
      (t/is (= [200 120] ((juxt :width :height) source-card)))
      (t/is (false? (:show-content source-card)))
      (t/is (= (boolean show-content) (boolean (:show-content source-root)))
            "the ordinary screen retains its own clipping policy")
      (t/is (= nodes (get-in candidate [:entries "screens/roundtrip.json" :presentations 0 :nodes])))
      (assert-consistent-shape-tree objects))))

(defn- shadow-specimen-ref
  [color-value]
  {:attribute "shadow"
   :caption (specimen-caption-id 8)
   :ownerPackageId "pkg_roundtrip"
   :path "effect/md.elevation-1"
   :raw {:blur 4
         :color color-value
         :offsetX 0
         :offsetY 2
         :spread 0}
   :setId "tset_canvas_effect"
   :setName "effect"
   :shape (str (specimen-shape-id 8))
   :tokenId "tok_canvas_effect_elevation"
   :type "shadow"
   :value {:blur 4
           :color color-value
           :offsetX 0
           :offsetY 2
           :spread 0}})

(t/deftest design-system-shadow-specimen-projects-a-valid-native-shadow
  ;; The native effects panel edits the :shadow VECTOR and re-validates each
  ;; record against the common Shadow schema (ctss/check-shadow); the
  ;; projection must emit records that already satisfy it (DSE-R04).
  (let [page   (design-system-page
                (design-system-snapshot
                 {"tok_canvas_effect_elevation"
                  (shadow-specimen-ref "rgba(0, 0, 0, 0.24)")}))
        shape  (get (:objects page) (specimen-shape-id 8))
        shadow (:shadow shape)]
    (t/is (vector? shadow))
    (t/is (= 1 (count shadow)))
    (let [record (first shadow)]
      (t/is (ctss/valid-shadow? record))
      (t/is (= :drop-shadow (:style record)))
      (t/is (false? (:hidden record)))
      (t/is (= 4 (:blur record)))
      (t/is (= 2 (:offset-y record)))
      (t/is (= 0 (:offset-x record)))
      (t/is (= 0 (:spread record)))
      (t/is (= {:color "#000000" :opacity 0.24} (:color record))))))

(t/deftest design-system-shadow-specimen-parses-hex-colors
  (let [page   (design-system-page
                (design-system-snapshot
                 {"tok_canvas_effect_elevation"
                  (shadow-specimen-ref "#ff8800")}))
        record (-> (get (:objects page) (specimen-shape-id 8))
                   (:shadow)
                   (first))]
    (t/is (ctss/valid-shadow? record))
    (t/is (= {:color "#ff8800" :opacity 1} (:color record)))))

;; A shadow Cell may hold a list of shadows (Tokens Studio and Penpot both
;; write one); the specimen shows every one of them.
(t/deftest design-system-shadow-specimen-takes-a-list-of-shadows
  (let [shadows [{:blur 2 :color "#1018281a" :offsetX 0 :offsetY 1 :spread 0}
                 {:blur 8 :color "#ff0000" :offsetX 4 :offsetY 0 :spread 0}]
        ref     (assoc (shadow-specimen-ref "#000000")
                       :raw shadows :value shadows :resolved shadows)
        page    (design-system-page
                 (design-system-snapshot {"tok_canvas_effect_elevation" ref}))
        records (:shadow (get (:objects page) (specimen-shape-id 8)))]
    (t/is (= 2 (count records)))
    (t/is (every? ctss/valid-shadow? records))
    (t/is (= [1 0] (mapv :offset-y records)))))

(def chip-container-id #uuid "d5e00000-0000-4000-8000-000000000042")
(def chip-neutral-cmp-id #uuid "d5e00000-0000-4000-8000-000000000043")
(def chip-brand-cmp-id #uuid "d5e00000-0000-4000-8000-000000000044")
(def chip-neutral-root-id #uuid "d5e00000-0000-4000-8000-000000000045")
(def chip-brand-root-id #uuid "d5e00000-0000-4000-8000-000000000046")

(defn- chip-variant
  [variant-id tone width]
  {:id variant-id
   :rootId "node_chip_root"
   :selection {:axis_tone tone}
   :nodes {:node_chip_root {:children []
                            :fills [{:color "#e5e7eb" :type "solid"}]
                            :height 32
                            :id "node_chip_root"
                            :name "Chip root"
                            :type "COMPONENT"
                            :width width
                            :x 0
                            :y 0}}})

(defn- chip-snapshot
  "Base snapshot plus a Component Set with one axis (two variants) next to
  the plain Card set of the design-system fixture."
  []
  (-> (design-system-snapshot [])
      (update-in [:manifest :entries :components] conj "components/chip.json")
      (assoc-in [:entries "components/chip.json"]
                {:componentSets
                 [{:axes [{:domain ["neutral" "brand"]
                           :id "axis_tone"
                           :name "Tone"
                           :role "configuration"}]
                   :id "cmp_chip"
                   :name "Chip"
                   :variants [(chip-variant "var_neutral" "neutral" 96)
                              (chip-variant "var_brand" "brand" 120)]}]})
      (assoc-in [:runtime :components :cmp_chip] (str chip-container-id))
      (assoc-in [:runtime :variants :cmp_chip]
                {:var_neutral (str chip-neutral-cmp-id)
                 :var_brand (str chip-brand-cmp-id)})
      (assoc-in [:runtime :componentNodes :cmp_chip]
                {:var_neutral {:node_chip_root (str chip-neutral-root-id)}
                 :var_brand {:node_chip_root (str chip-brand-root-id)}})))

(t/deftest component-sets-with-axes-project-as-native-variants
  (let [file      (:file (projection/project-snapshot
                          (chip-snapshot)
                          {:file-id file-id :project-id project-id}))
        data      (:data file)
        page      (get-in data [:pages-index components-page-id])
        objects   (:objects page)
        container (get objects chip-container-id)
        neutral   (get objects chip-neutral-root-id)
        brand     (get objects chip-brand-root-id)]
    (t/is (true? (:is-variant-container container)))
    (t/is (= "Chip" (:name container)))
    ;; Penpot's first (primary) variant is the container's last child.
    (t/is (= [chip-brand-root-id chip-neutral-root-id] (:shapes container)))
    (t/is (contains? (set (:shapes (get objects uuid/zero))) chip-container-id))
    (doseq [[main tone] [[neutral "neutral"] [brand "brand"]]]
      (t/is (= chip-container-id (:parent-id main)))
      (t/is (= chip-container-id (:frame-id main)))
      (t/is (= chip-container-id (:variant-id main)))
      (t/is (= tone (:variant-name main)))
      (t/is (= "Chip" (:name main)))
      (t/is (true? (:main-instance main))))
    ;; Mains sit inside the container padding, one grid cell each.
    (t/is (= (+ (:x container) 30) (:x neutral)))
    (t/is (< (+ (:x neutral) (:width neutral)) (:x brand)))
    (t/is (= {:id chip-neutral-cmp-id
              :name "Chip"
              :path ""
              :main-instance-id chip-neutral-root-id
              :main-instance-page components-page-id
              :variant-id chip-container-id
              :variant-properties [{:name "Tone" :value "neutral"}]}
             (get-in data [:components chip-neutral-cmp-id])))
    ;; A set without axes stays a plain component outside any container.
    (t/is (nil? (get-in data [:components variant-cmp-id :variant-id])))
    (t/is (= uuid/zero (:parent-id (get objects sample-root-id))))
    ;; Penpot's own referential checks accept the variant structure.
    (t/is (empty? (cfv/validate-shape chip-container-id file page {})))))

(t/deftest variant-properties-follow-penpot-naming-for-repeated-axes
  (t/is (= [{:name "Size" :value "sm"} {:name "Size (1)" :value "lg"}]
           (#'projection/variant-properties
            {:axes [{:id "axis_a" :name "Size"} {:id "axis_b" :name "Size"}]}
            {:selection {:axis_a "sm" :axis_b "lg"}}))))

(defn- cartesian-set
  "A Component Set with one variant per combination of `axes` values
  ([id name values] each, first axis outermost), sized by `size`."
  [name axes & {:keys [size] :or {size (constantly [40 20])}}]
  (let [selections (reduce (fn [selections [id _ values]]
                             (for [selection selections value values]
                               (assoc selection (keyword id) value)))
                           [{}]
                           axes)]
    {:id (str "cmp_" name)
     :name name
     :axes (mapv (fn [[id name values]] {:id id :name name :domain values}) axes)
     :variants (vec (map-indexed
                     (fn [index selection]
                       (let [[width height] (size selection)]
                         {:id (str "v" index)
                          :rootId "root"
                          :selection selection
                          :nodes {:root {:children [] :height height :id "root"
                                         :type "FRAME" :width width :x 0 :y 0}}}))
                     selections))}))

(def ^:private task-card-axes
  [["axis_width" "Width" ["compact" "wide"]]
   ["axis_state" "State" ["default" "selected" "blocked"]]
   ["axis_status" "Status" ["backlog" "todo" "progress" "review" "done" "blocked"]]
   ["axis_priority" "Priority" ["low" "medium" "high"]]])

(t/deftest variant-matrix-puts-the-last-axis-in-columns
  (let [matrix #'projection/variant-matrix
        one    (matrix (cartesian-set "Tag" [["axis_tone" "Tone" ["neutral" "brand"]]]))
        two    (matrix (cartesian-set "Header" [["axis_width" "Width" ["compact" "wide"]]
                                                ["axis_status" "Status" ["todo" "done" "blocked"]]]))
        four   (matrix (cartesian-set "Task card" task-card-axes))
        wide   (matrix (cartesian-set "Wide" [["axis_a" "A" ["1" "2" "3" "4" "5"]]
                                              ["axis_b" "B" ["x" "y"]]
                                              ["axis_c" "C" ["p" "q" "r"]]]))]
    (t/is (= ["Tone"] (mapv :name (:column-axes one))))
    (t/is (= [] (:row-axes one)))
    (t/is (= [["neutral"] ["brand"]] (:columns one)))
    (t/is (= [[]] (:rows one)))
    (t/is (= ["Status"] (mapv :name (:column-axes two))))
    (t/is (= ["Width"] (mapv :name (:row-axes two))))
    (t/is (= [["compact"] ["wide"]] (:rows two)))
    ;; Every column holds one value of the last axis, every row one
    ;; combination of the others.
    (doseq [{:keys [variant column row]} (:cells two)]
      (t/is (= [(get-in variant [:selection :axis_status])] (nth (:columns two) column)))
      (t/is (= [(get-in variant [:selection :axis_width])] (nth (:rows two) row))))
    ;; Four axes: the first one groups the columns, 2 x 3 = 6 of them.
    (t/is (= ["Width" "Priority"] (mapv :name (:column-axes four))))
    (t/is (= ["State" "Status"] (mapv :name (:row-axes four))))
    (t/is (= [["compact" "low"] ["compact" "medium"] ["compact" "high"]
              ["wide" "low"] ["wide" "medium"] ["wide" "high"]]
             (:columns four)))
    (t/is (= 18 (count (:rows four))))
    (t/is (= ["default" "backlog"] (first (:rows four))))
    (t/is (= 108 (count (distinct (map (juxt :column :row) (:cells four))))))
    ;; Grouping by the first axis would make 5 x 3 = 15 columns: it stays
    ;; the outermost row axis instead.
    (t/is (= ["C"] (mapv :name (:column-axes wide))))
    (t/is (= ["A" "B"] (mapv :name (:row-axes wide))))))

(t/deftest variant-matrix-orders-values-by-domain-then-new-values
  (let [base    (cartesian-set "Badge" [["axis_tone" "Tone" ["info" "success" "danger"]]])
        added   (assoc-in (first (:variants base)) [:selection :axis_tone] "Value 5")
        matrix  (#'projection/variant-matrix
                 (assoc base :variants (vec (reverse (conj (:variants base)
                                                           (assoc added :id "v_new"))))))]
    (t/is (= [["info"] ["success"] ["danger"] ["Value 5"]] (:columns matrix)))))

(defn- overlap?
  [[ax ay aw ah] [bx by bw bh]]
  (and (< ax (+ bx bw)) (< bx (+ ax aw)) (< ay (+ by bh)) (< by (+ ay ah))))

(t/deftest component-set-block-draws-an-axis-table-with-headers
  (let [button     (cartesian-set "Button"
                                  [["axis_style" "Style" ["primary" "secondary" "ghost"]]
                                   ["axis_size" "Size" ["sm" "md" "lg"]]
                                   ["axis_state" "State" ["default" "hover" "disabled"]]]
                                  :size (fn [{:keys [axis_size]}]
                                          (case axis_size "sm" [80 28] "md" [96 36] [120 44])))
        block      (#'projection/component-set-block "cmp_button" button 100 200)
        texts      (frequencies (map :text (:labels block)))
        {:keys [container placements]} block
        at         (into {} (map (juxt (comp :selection :variant)
                                       (juxt :offset-x :offset-y)))
                         placements)
        boxes      (mapv (fn [{:keys [variant offset-x offset-y]}]
                           (let [root (get-in variant [:nodes :root])]
                             [offset-x offset-y (:width root) (:height root)]))
                         placements)
        labels     (mapv (fn [{:keys [text x y size]}]
                           (let [{:keys [width height]} (#'projection/board-text-metrics text size)]
                             [x y width height]))
                         (:labels block))]
    (t/is (= block (#'projection/component-set-block "cmp_button" button 100 200))
          "the layout is a function of the set alone")
    (doseq [style ["primary" "secondary" "ghost"]]
      (t/is (= 1 (texts (str "Style: " style))) "one header per column group"))
    (doseq [state ["default" "hover" "disabled"]]
      (t/is (= 3 (texts state)) "one column header per State value in each group"))
    (doseq [size ["sm" "md" "lg"]]
      (t/is (= 1 (texts size)) "one row header per Size value"))
    (t/is (= 1 (texts "Size / State")))
    ;; A column is one (Style, State) pair, a row one Size.
    (t/is (= 9 (count (distinct (map first (vals at))))))
    (t/is (= 3 (count (distinct (map second (vals at))))))
    (t/is (= (first (at {:axis_style "primary" :axis_size "sm" :axis_state "hover"}))
             (first (at {:axis_style "primary" :axis_size "lg" :axis_state "hover"}))))
    (t/is (= (second (at {:axis_style "primary" :axis_size "md" :axis_state "default"}))
             (second (at {:axis_style "ghost" :axis_size "md" :axis_state "disabled"}))))
    ;; Mains and labels keep inside the container padding, and nothing
    ;; overlaps a main.
    (doseq [[x y w h] (concat boxes labels)]
      (t/is (<= (+ (:x container) 30) x))
      (t/is (<= (+ x w) (- (+ (:x container) (:width container)) 30)))
      (t/is (<= (+ (:y container) 30) y))
      (t/is (<= (+ y h) (- (+ (:y container) (:height container)) 30))))
    (t/is (not-any? true? (for [i (range (count boxes))
                                j (range (count (concat boxes labels)))
                                :when (not= i j)]
                            (overlap? (nth boxes i) (nth (vec (concat boxes labels)) j)))))))

(t/deftest component-set-block-keeps-variant-order-and-stacks-duplicates
  (let [base   (cartesian-set "Tag" [["axis_tone" "Tone" ["neutral" "brand"]]])
        twin   (assoc (first (:variants base)) :id "v_twin")
        block  (#'projection/component-set-block "cmp_tag" (update base :variants conj twin) 0 0)
        [a _ c] (:placements block)]
    (t/is (= ["v0" "v1" "v_twin"] (mapv (comp :id :variant) (:placements block)))
          "Penpot's primary variant stays first")
    (t/is (= (:offset-x a) (:offset-x c)))
    (t/is (= (+ (:offset-y a) 20 20) (:offset-y c)) "a duplicate stacks below in its cell")))

(t/deftest components-page-labels-are-locked-decoration-outside-containers
  (let [candidate (-> (chip-snapshot)
                      (assoc-in [:entries "components/chip.json" :componentSets 0 :category]
                                "Status")
                      (update-in [:manifest :entries :components] conj "components/located.json")
                      (assoc-in [:entries "components/located.json"]
                                {:id "cmp_located"
                                 :mainNodeId "node_rectangle"
                                 :name "Located rectangle"
                                 :path ""
                                 :presentationId "pres_desktop"
                                 :screenId "scr_roundtrip"})
                      (assoc-in [:runtime :components :cmp_located] (str located-component-id)))
        project   #(:file (projection/project-snapshot
                           candidate
                           {:file-id file-id :project-id project-id}))
        file      (project)
        data      (:data file)
        page      (get-in data [:pages-index components-page-id])
        objects   (:objects page)
        labels    (filter #(= "decoration" (get-in % [:plugin-data :smallpen "components-page"]))
                          (vals objects))
        texts     (set (keep #(when (= :text (:type %)) (:name %)) labels))]
    (t/is (= objects (get-in (project) [:data :pages-index components-page-id :objects]))
          "every label keeps its id and place across projections")
    (t/is (seq labels))
    (t/is (every? :blocked labels))
    (t/is (not-any? #(= chip-container-id (:parent-id %)) labels))
    (t/is (= [chip-brand-root-id chip-neutral-root-id] (:shapes (get objects chip-container-id)))
          "the container holds only its variant mains")
    (doseq [text ["Status" "neutral" "brand" "Located rectangle"]]
      (t/is (contains? texts text) text))
    (t/is (= "Status" (get-in data [:components chip-neutral-cmp-id :path]))
          "the category is the Assets folder")
    (t/is (= "" (get-in data [:components variant-cmp-id :path])))
    (assert-consistent-shape-tree objects)
    (t/is (empty? (cfv/validate-shape chip-container-id file page {})))))

(t/deftest flowed-component-blocks-match-layout-at-their-final-coordinates
  (let [large      (assoc (cartesian-set "Large" task-card-axes
                                         :size (constantly [200 80]))
                          :category "Composite")
        compact    (assoc (cartesian-set "Compact" [["tone" "Tone" ["neutral" "brand"]]])
                          :category "Composite")
        duplicate  (update compact :variants conj (assoc (first (:variants compact)) :id "twin"))
        plain      (cartesian-set "Plain" [])
        candidate  (-> snapshot
                       (assoc-in [:manifest :entries :components] ["components/sets.json"])
                       (assoc-in [:entries "components/sets.json"]
                                 {:componentSets [large duplicate plain]}))
        blocks     (:blocks (#'projection/components-page-layout candidate))]
    (t/is (= ["cmp_Large" "cmp_Compact" "cmp_Plain"] (mapv :component-id blocks)))
    (t/is (< (get-in (first blocks) [:container :y])
             (get-in (second blocks) [:container :y])) "the next block wraps below the wide matrix")
    (doseq [{:keys [component-id component-set placements container] :as block} blocks]
      (let [x (if container (:x container) (:offset-x (first placements)))
            y (if container (:y container) (:offset-y (first placements)))]
        (t/is (= (#'projection/component-set-block component-id component-set x y)
                 block))))))
