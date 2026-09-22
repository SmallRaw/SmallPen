;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns frontend-tests.smallpen.projection-test
  (:require
   [app.main.smallpen.token-state :as spts]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.shape.shadow :as ctss]
   [app.common.uuid :as uuid]
   [app.main.smallpen.projection :as projection]
   [app.main.smallpen.session :as session]
   [cljs.test :as t]))

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
         :x 380
         :y 120}
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
         :x 580
         :y 120}
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
                                 :objects instance-child-id])]
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
    (t/is (= #{:fill-group} (:touched copy-child)))))

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
    (t/is (= #{:fill-group} (:touched copy-child)))))

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
    (t/is (true? (:flip-x shape)))
    (t/is (= 30 (:rotation shape)))
    (t/is (not= (:points plain) (:points shape)))
    (t/is (not= (:transform plain) (:transform shape)))))

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

(defn- fill-specimen-ref
  [n]
  {:attribute "fill"
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

(defn- design-system-page
  [candidate]
  (-> (projection/project-snapshot
       candidate
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

(t/deftest design-system-page-keeps-one-consistent-parent-child-tree
  (let [specimen-id (specimen-shape-id 1)
        page   (design-system-page
                (design-system-snapshot {"tok_color_primary"
                                         (fill-specimen-ref 1)}))
        objects (:objects page)
        board   (get objects ds-board-id)]
    (t/is (= :frame (:type board)))
    ;; The board lists direct children only: the label, the top-level
    ;; specimens, and the sample ROOT — never the sample's descendants.
    (t/is (= [ds-label-id tokens-section-id components-section-id
              specimen-id ds-sample-id sample-root-id]
             (:shapes board)))
    ;; ...so both traversal directions describe the same tree.
    (t/is (= ds-board-id (:parent-id (get objects sample-root-id))))
    (t/is (= sample-root-id (:parent-id (get objects sample-body-id))))
    (t/is (= [sample-body-id] (:shapes (get objects sample-root-id))))
    (t/is (= sample-body-id (:parent-id (get objects sample-text-id))))
    (t/is (= [sample-text-id] (:shapes (get objects sample-body-id))))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-gap-specimen-children-are-listed-once
  (let [ref (assoc (fill-specimen-ref 1)
                   :attribute "gap"
                   :value 16
                   :children [(str specimen-child-a-id)
                              (str specimen-child-b-id)])
        page    (design-system-page
                 (design-system-snapshot {"tok_space_gap" ref}))
        objects (:objects page)
        board   (get objects ds-board-id)
        frame   (get objects (specimen-shape-id 1))]
    (t/is (= :frame (:type frame)))
    ;; The gap frame lists its two fillers exactly once.
    (t/is (= [specimen-child-a-id specimen-child-b-id] (:shapes frame)))
    (t/is (= (specimen-shape-id 1)
             (:parent-id (get objects specimen-child-a-id))))
    (t/is (= (specimen-shape-id 1)
             (:parent-id (get objects specimen-child-b-id))))
    ;; Fillers belong to their frame, not to the board.
    (t/is (= [ds-label-id tokens-section-id components-section-id
              (specimen-shape-id 1) ds-sample-id sample-root-id]
             (:shapes board)))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-specimen-grid-wraps-without-dropping-specimens
  (let [n 7
        specimens (into {}
                        (map (fn [i] [(str "tok_color_swatch" i)
                                      (fill-specimen-ref i)]))
                        (range 1 (inc n)))
        page      (design-system-page (design-system-snapshot specimens))
        objects   (:objects page)
        board     (get objects ds-board-id)
        specimen-ids (mapv specimen-shape-id (range 1 (inc n)))]
    ;; Every input specimen reaches the objects map exactly once.
    (t/is (= (set specimen-ids)
             (set (filter (set specimen-ids) (map :id (vals objects))))))
    (t/is (= (into [ds-label-id tokens-section-id components-section-id]
                   (concat specimen-ids [ds-sample-id sample-root-id]))
             (:shapes board)))
    ;; Row 1 holds five 96px swatches (x 40/160/280/400/520, y 116); the 6th
    ;; specimen is the first overflow and must open row 2 instead of being
    ;; consumed by the wrap.
    (t/is (= [40 160 280 400 520]
             (mapv :x (map objects (take 5 specimen-ids)))))
    (t/is (every? #(= 116 (:y %)) (map objects (take 5 specimen-ids))))
    (t/is (= 40 (:x (get objects (nth specimen-ids 5)))))
    (t/is (= 192 (:y (get objects (nth specimen-ids 5)))))
    (t/is (= 160 (:x (get objects (nth specimen-ids 6)))))
    (t/is (= 192 (:y (get objects (nth specimen-ids 6)))))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-specimen-grid-places-mixed-widths-and-empty-sets
  (let [gap-ref (assoc (fill-specimen-ref 6)
                       :attribute "gap"
                       :value 16
                       :children [(str specimen-child-a-id)
                                  (str specimen-child-b-id)])
        specimens (merge
                   (into {} (map (fn [i]
                                   [(str "tok_color_swatch" i)
                                    (fill-specimen-ref i)]))
                         (range 1 6))
                   {"tok_space_gap" gap-ref})
        page      (design-system-page (design-system-snapshot specimens))
        objects   (:objects page)
        board     (get objects ds-board-id)
        gap-frame (get objects (specimen-shape-id 6))]
    ;; Five swatches fill row 1; the 120px gap frame is the first item that
    ;; does not fit and opens row 2 at the pad origin.
    (t/is (= 40 (:x gap-frame)))
    (t/is (= 192 (:y gap-frame)))
    ;; An empty specimen set leaves only the label plus the sample tree.
    (let [empty-page   (design-system-page (design-system-snapshot {}))
          empty-objects (:objects empty-page)
          empty-board   (get empty-objects ds-board-id)]
      (t/is (= [ds-label-id tokens-section-id components-section-id
                tokens-empty-id ds-sample-id sample-root-id]
               (:shapes empty-board)))
      (t/is (= #{"Label · No Tokens"}
               (into #{}
                     (comp (map :name)
                           (filter #{"Label · No Tokens" "Label · No Pages"}))
                     (vals empty-objects))))
      (t/is (nil? (get empty-objects (specimen-shape-id 1))))
      (assert-consistent-shape-tree empty-objects))
    (assert-consistent-shape-tree objects)))

(t/deftest design-system-token-cells-show-group-metadata-and-real-visuals
  (let [white-ref       (assoc (fill-specimen-ref 1)
                               :caption (str token-caption-a-id)
                               :raw "#ffffff"
                               :status "active"
                               :value "#ffffff")
        transparent-ref (assoc (fill-specimen-ref 2)
                               :caption (str token-caption-b-id)
                               :path "color.transparent"
                               :raw "#00000000"
                               :status "active"
                               :value "#00000000")
        typography-ref  (assoc (fill-specimen-ref 3)
                               :attribute nil
                               :caption (str token-caption-c-id)
                               :path "heading"
                               :raw {:fontFamily "Inter"
                                     :fontId "gfont-inter"
                                     :fontSize 28
                                     :fontWeight 600
                                     :lineHeight 1.2}
                               :status "active"
                               :type "typography"
                               :value {:fontFamily "Inter"
                                       :fontId "gfont-inter"
                                       :fontSize 28
                                       :fontWeight 600
                                       :lineHeight 1.2}
                               :writable false)
        alias-ref       (assoc (fill-specimen-ref 4)
                               :alias true
                               :attribute "radius"
                               :caption (str token-caption-d-id)
                               :path "radius.alias"
                               :raw "{base}"
                               :status "archived"
                               :type "border-radius"
                               :value "{base}"
                               :writable false)
        alpha-ref       (assoc (fill-specimen-ref 5)
                               :caption (str token-caption-e-id)
                               :path "color.alpha"
                               :raw "#33669980"
                               :status "active"
                               :value "#33669980")
        structured-ref  (assoc (fill-specimen-ref 6)
                               :caption (str token-caption-f-id)
                               :path "color.structured"
                               :raw {:alpha 0.25
                                     :colorSpace "srgb"
                                     :components [1 0 0.5]}
                               :status "active"
                               :value {:alpha 0.25
                                       :colorSpace "srgb"
                                       :components [1 0 0.5]})
        candidate       (-> (design-system-snapshot
                             {"white" white-ref
                              "transparent" transparent-ref
                              "typography" typography-ref
                              "alias" alias-ref
                              "alpha" alpha-ref
                              "structured" structured-ref})
                            (assoc-in [:runtime :designSystemRefs :tokenGroups]
                                      [{:header (str token-group-a-id)
                                        :ownerPackageId "pkg_roundtrip"
                                        :setId "tset_core"
                                        :setName "core"
                                        :type "color"}
                                       {:header (str token-group-b-id)
                                        :ownerPackageId "pkg_roundtrip"
                                        :setId "tset_core"
                                        :setName "core"
                                        :type "typography"}
                                       {:header (str token-group-c-id)
                                        :ownerPackageId "pkg_roundtrip"
                                        :setId "tset_core"
                                        :setName "core"
                                        :type "border-radius"}]))
        page            (design-system-page candidate)
        objects         (:objects page)
        white           (get objects (specimen-shape-id 1))
        transparent     (get objects (specimen-shape-id 2))
        typography      (get objects (specimen-shape-id 3))
        alpha            (get objects (specimen-shape-id 5))
        structured       (get objects (specimen-shape-id 6))
        white-caption    (get objects token-caption-a-id)
        transparent-caption (get objects token-caption-b-id)
        caption-names   (into #{} (map :name) (vals objects))]
    (t/is (contains? caption-names "Label · pkg_roundtrip / core / color"))
    (t/is (contains? caption-names
                     "Label · pkg_roundtrip · core · color\ncolor.swatch1 = #ffffff · literal · active"))
    (t/is (contains? caption-names
                     "Label · pkg_roundtrip · core · border-radius\nradius.alias = {base} · alias · archived"))
    (t/is (= :solid (get-in white [:strokes 0 :stroke-style])))
    (t/is (= :dashed (get-in transparent [:strokes 0 :stroke-style])))
    (t/is (= 0 (get-in transparent [:fills 0 :fill-opacity])))
    (t/is (= "#336699" (get-in alpha [:fills 0 :fill-color])))
    (t/is (< (js/Math.abs (- (/ 128 255) (get-in alpha [:fills 0 :fill-opacity]))) 0.0001))
    (t/is (= {:fill-color "#ff0080" :fill-opacity 0.25}
             (get-in structured [:fills 0])))
    (t/is (or (not= (:y white-caption) (:y transparent-caption))
              (<= (+ (:x white-caption) (:width white-caption))
                  (:x transparent-caption)))
          "measured multiline captions do not overlap on a narrow board")
    (t/is (= :text (:type typography)))
    (t/is (= "28" (get-in typography [:content :children 0 :children 0
                                       :children 0 :font-size])))
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
        result (projection/project-snapshot candidate {:file-id file-id :project-id project-id})
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
          result (projection/project-snapshot candidate {:file-id file-id :project-id project-id})
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
   :ownerPackageId "pkg_roundtrip"
   :path "effect/md.elevation-1"
   :raw color-value
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

(t/deftest design-system-sizing-flow-reserves-the-clamped-visual-height
  (let [specimens (into {}
                        (map (fn [i]
                               [(str "sizing-" i)
                                (assoc (fill-specimen-ref i)
                                       :attribute "height"
                                       :type "sizing"
                                       :value (if (= i 1) 300 8))]))
                        (range 1 8))
        objects (:objects (design-system-page (design-system-snapshot specimens)))
        tall    (get objects (specimen-shape-id 1))
        wrapped (get objects (specimen-shape-id 6))]
    (t/is (= 160 (:height tall)))
    (t/is (>= (:y wrapped) (+ (:y tall) (:height tall) 28))
          "the next row starts below the actual clamped sizing sample")))

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
