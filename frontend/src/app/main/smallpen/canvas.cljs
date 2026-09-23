(ns app.main.smallpen.canvas
  (:require
   [app.main.smallpen :as smallpen]
   [rumext.v2 :as mf]))

(mf/defc canvas-page*
  {::mf/props :obj}
  [{:keys [file-id]}]
  (let [st            (mf/use-state {:loading true :data nil})
        container-ref (mf/use-ref nil)
        {:keys [loading error data selection]} @st]
    (mf/use-effect
     (mf/deps file-id)
     (fn []
       (let [active (atom true)]
         (swap! st assoc :loading true :error nil :data nil :selection nil)
         (-> (smallpen/canvas-workspace nil)
             (.then (fn [payload]
                      (when @active
                        (swap! st assoc :loading false :data payload))))
             (.catch (fn [cause]
                       (when @active
                         (swap! st assoc :loading false :error (str cause))))))
         #(reset! active false))))
    (mf/use-effect
     (mf/deps data)
     (fn []
       (when data
         (when-let [container (mf/ref-val container-ref)]
           (try
             (if (.-renderCanvas js/window)
               (let [svg (js/window.renderCanvas
                          container (clj->js data :keyword-fn #(subs (str %) 1))
                          #js {:onSelect
                               (fn [_ node]
                                 (swap! st assoc :selection
                                        (.stringify js/JSON (unchecked-get node "sourceRef") nil 2)))})]
                 #(.remove svg))
               (do
                 (swap! st assoc :error "画布渲染器未加载，请刷新页面")
                 nil))
             (catch :default cause
               (swap! st assoc :error (str cause))
               nil))))))
    [:div {:data-testid "smallpen-canvas"
           :style #js {:display "flex" :flexDirection "column" :height "100vh"
                       :backgroundColor "var(--color-background-primary)" :color "var(--color-foreground-primary)"
                       :fontFamily "Inter,sans-serif" :boxSizing "border-box"}}
     [:header {:style #js {:display "flex" :alignItems "baseline" :gap "12px"
                           :padding "12px 20px 4px"}}
      [:h2 {:style #js {:fontSize "16px" :fontWeight "600" :margin "0"
                        :color "var(--color-foreground-primary)"}} "设计系统画布"]
      [:a {:href (str "#/workspace?file-id=" (or file-id ""))
           :data-testid "canvas-back-to-editor"
           :style #js {:color "var(--color-foreground-secondary)" :fontSize "12px" :textDecoration "none"}}
       "返回编辑器"]
      [:a {:href "#/smallpen"
           :style #js {:color "var(--color-foreground-secondary)" :fontSize "12px" :textDecoration "none"}}
       "首页"]]
     (cond
       error
       [:p {:data-testid "canvas-error"
            :style #js {:color "var(--color-accent-error)" :padding "0 24px" :fontSize "13px"}}
        (str "加载失败：" error)]
       loading
       [:p {:data-testid "canvas-loading"
            :style #js {:color "var(--color-foreground-secondary)" :padding "0 24px" :fontSize "13px"}}
        "加载中…"]
       :else
       [:div {:style #js {:display "flex" :flex "1" :gap "12px"
                          :padding "8px 20px 20px" :minHeight "0"}}
        [:div {:ref container-ref
               :data-testid "canvas-viewport"
               :style #js {:width "100%" :height "100%"
                           :backgroundColor "var(--color-background-primary)"
                           :border "1px solid var(--color-background-quaternary)"
                           :borderRadius "8px" :display "block"}}]
        [:div {:data-testid "canvas-inspector"
               :style #js {:width "300px" :flexShrink "0" :padding "12px"
                           :border "1px solid var(--color-background-quaternary)" :borderRadius "8px"
                           :backgroundColor "var(--color-background-secondary)"}}
         (when selection
           [:div
            [:h3 "来源"]
            [:pre selection]])]])]))
