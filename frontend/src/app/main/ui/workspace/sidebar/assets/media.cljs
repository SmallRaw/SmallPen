;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.sidebar.assets.media
  (:require
   [app.config :as cf]
   [app.main.data.workspace.media :as dwm]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.sidebar.assets.common :as cmm]
   [app.util.dom.dnd :as dnd]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def ^:private media-list-style
  #js {:display "grid"
       :gap "var(--sp-xxs)"
       :inlineSize "var(--options-width)"
       :paddingInlineStart "var(--sp-xs)"})

(def ^:private media-item-style
  #js {:alignItems "center"
       :background "var(--color-background-tertiary)"
       :borderRadius "0.5rem"
       :color "var(--color-foreground-primary)"
       :cursor "grab"
       :display "grid"
       :gap "var(--sp-xs)"
       :gridTemplateColumns "2.5rem minmax(0, 1fr)"
       :minBlockSize "3rem"
       :padding "var(--sp-xxs) var(--sp-xs)"})

(def ^:private media-thumbnail-style
  #js {:background "var(--color-canvas)"
       :blockSize "2.5rem"
       :borderRadius "0.375rem"
       :inlineSize "2.5rem"
       :objectFit "contain"
       :padding "var(--sp-xxs)"
       :pointerEvents "none"})

(def ^:private media-copy-style
  #js {:display "grid"
       :minInlineSize 0})

(def ^:private media-name-style
  #js {:overflow "hidden"
       :textOverflow "ellipsis"
       :whiteSpace "nowrap"})

(def ^:private media-meta-style
  #js {:color "var(--color-foreground-secondary)"
       :fontFamily "var(--font-family-monospace)"
       :fontSize "0.75rem"})

(mf/defc media-item*
  {::mf/private true}
  [{:keys [media]}]
  (let [{:keys [height id mtype name path width]} media
        dimensions (str width " × " height)
        metadata (if (seq path)
                   (str path " · " dimensions)
                   dimensions)
        on-drag-start
        (mf/use-fn
         (mf/deps height id mtype name width)
         (fn [event]
           (dnd/set-data! event "text/asset-id" (str id))
           (dnd/set-data! event "text/asset-name" name)
           (dnd/set-data! event "text/asset-type" mtype)
           (dnd/set-data! event "text/asset-width" (str width))
           (dnd/set-data! event "text/asset-height" (str height))
           (dnd/set-allowed-effect! event "copy")))
        on-double-click
        (mf/use-fn
         (mf/deps media)
         (fn [_]
           (st/emit! (dwm/place-library-media media))))
        on-key-down
        (mf/use-fn
         (mf/deps media)
         (fn [event]
           (when (contains? #{"Enter" " "} (.-key event))
             (.preventDefault event)
             (st/emit! (dwm/place-library-media media)))))]
    [:div {:aria-label (str name " " metadata " " mtype)
           :data-testid "smallpen-library-media"
           :draggable true
           :on-double-click on-double-click
           :on-drag-start on-drag-start
           :on-key-down on-key-down
           :role "button"
           :style media-item-style
           :tab-index 0
           :title (str name "\n" metadata "\n" mtype)}
     [:img {:alt ""
            :draggable false
            :style media-thumbnail-style
            :src (cf/resolve-file-media media true)}]
     [:span {:style media-copy-style}
      [:span {:style media-name-style} name]
      [:span {:style media-meta-style} metadata]]]))

(mf/defc media-section*
  [{:keys [file-id is-open media]}]
  [:> cmm/asset-section* {:file-id file-id
                          :title (tr "workspace.assets.graphics")
                          :section :graphics
                          :icon i/graphics
                          :assets-count (count media)
                          :is-open is-open}
   [:> cmm/asset-section-block* {:role :content}
    [:div {:style media-list-style}
     (for [item media]
       [:> media-item* {:key (str (:id item))
                        :media item}])]]])
