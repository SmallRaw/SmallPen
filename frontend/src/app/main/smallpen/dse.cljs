;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.dse
  ;; DSE-011-A: drag-free component creation on the generated Design System
  ;; page. The generated page has no source parent, so both flows take an
  ;; EXPLICIT writable destination (a real screen page + container) and run
  ;; through the ordinary component machinery (generate + commit-changes +
  ;; one undo transaction) — no bespoke write path.
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.geom.point :as gpt]
   [app.common.logic.libraries :as cll]
   [app.common.types.file :as ctf]
   [app.common.types.components-list :as ctkl]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.undo :as dwu]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(defn design-system-page?
  "True when the given projected page is the generated Design System page."
  [page]
  (some-> page :plugin-data :smallpen (get "design-system-page")))

(defn generated-page?
  "True for projection-only pages (generated Design System board, Components
  overview) that can never be a write destination."
  [page]
  (boolean
   (some (fn [[key _value]]
           (and (string? key)
                (or (str/starts-with? key "design-system")
                    (= key "components-page"))))
         (-> page :plugin-data :smallpen))))

(defn writable-containers
  "Destination choices for drag-free creation: every frame of every real
  screen page, labeled by page and frame name. Generated pages (Design
  System, Components) are excluded so decoration can never become a source
  parent."
  [file]
  (letfn [(walk [page page-name object path acc]
            (let [path (conj path (:name object))
                  acc  (cond-> acc
                         (and (= :frame (:type object))
                              (not (generated-page? page)))
                         (conj {:container-id (:id object)
                                :label (str page-name " / " (str/join " / " path))
                                :page-id (:id page)
                                :page-name page-name
                                :shape object}))]
              (reduce (fn [acc child-id]
                        (if-let [child (get-in file [:data :pages-index (:id page) :objects child-id])]
                          (walk page page-name child path acc)
                          acc))
                      acc
                      (:shapes object))))]
    (->> (get-in file [:data :pages])
         (mapcat (fn [page-id]
                   (let [page (get-in file [:data :pages-index page-id])]
                     (->> (:shapes (get-in page [:objects uuid/zero]))
                          (map (fn [root-id]
                                 (get-in page [:objects root-id])))
                          (reduce (fn [acc object]
                                    (walk page (:name page) object [] acc))
                                  [])))))
         (vec))))

(defn insert-panel-state
  "Affordance state for the sidebar insert panel (DSE-R05). Creating a NEW
  component definition only needs a writable destination; inserting an
  EXISTING instance is additionally gated by the components the package
  already has. The panel stays visible on the Design System page with an
  actionable reason instead of a failing fake entry."
  [file page]
  (let [containers (writable-containers file)
        components (ctkl/components-seq (:data file))
        can-edit?  (not (false? (get-in file [:permissions :can-edit])))]
    (if-not (design-system-page? page)
      {:can-create? false
       :can-insert? false
       :reason nil
       :visible? false}
      (cond-> {:reason nil :visible? true :has-components? (boolean (seq components))}
        (not can-edit?)
        (assoc :reason :read-only :can-create? false :can-insert? false)

        can-edit?
        (assoc :reason (when-not (seq containers) :no-container)
               :can-create? (boolean (seq containers))
               :can-insert? (boolean (and (seq containers) (seq components))))))))

(defn- find-container
  "Resolve the destination page + frame from the current file data. Generated
  pages can never be a destination, so they resolve to nil."
  [state file-id page-id container-id]
  (let [page (get-in (dsh/lookup-file-data state file-id) [:pages-index page-id])]
    (when (and page (not (generated-page? page)))
      (let [object (get-in page [:objects container-id])]
        (when (and object (= :frame (:type object)))
          [page object])))))

(defn- component-exists?
  [state file-id component-id]
  (some? (ctf/get-component (dsh/lookup-libraries state) file-id component-id)))

(defn insert-into-source
  "Insert an EXISTING component instance into an explicitly chosen writable
  source container, without any drag gesture (DSE-011-A). Uses the ordinary
  instantiate machinery: generate-instantiate-component + commit-changes, so
  the write reaches the source through the normal adapter and undo stack."
  [{:keys [component-id container-id file-id page-id]}]
  (ptk/reify ::insert-into-source
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id     (or file-id (:current-file-id state))
            [page container] (find-container state file-id page-id container-id)]
        (js/console.log "dse-insert-event" "page" (boolean page) "container" (boolean container)
                        "component" (component-exists? state file-id component-id))
        (when (and page container (component-exists? state file-id component-id))
          (let [objects   (or (:objects page) {})
                libraries (dsh/lookup-libraries state)
                position  (gpt/point (+ (:x container) 24)
                                     (+ (:y container) 24))
                [new-shape changes]
                (cll/generate-instantiate-component
                 (-> (pcb/empty-changes it page-id)
                     (pcb/with-objects objects))
                 objects
                 file-id
                 component-id
                 position
                 page
                 libraries
                 nil
                 (:id container)
                 (:id container)
                 {}
                 {})
                undo-id (js/Symbol)]
            (rx/of (dwu/start-undo-transaction undo-id)
                   (dch/commit-changes changes)
                   (dws/select-shapes (d/ordered-set (:id new-shape)))
                   (dwu/commit-undo-transaction undo-id))))))))

(defn create-component-in-source
  "Create a NEW component definition in an explicitly chosen writable source
  container, without any drag gesture (DSE-011-A). One undo transaction adds
  a frame (the primitive Component roots use) and then runs the ordinary
  create-component machinery over it."
  [{:keys [container-id page-id]}]
  (ptk/reify ::create-component-in-source
    ptk/WatchEvent
    (watch [it state _]
      (when-let [[page container]
                 (find-container state (:current-file-id state) page-id container-id)]
        (let [file-id  (:current-file-id state)
              objects  (or (:objects page) {})
              new-id   (uuid/next)
              ;; A FRAME root keeps generate-add-component on its
              ;; single-frame path: the frame itself becomes the component
              ;; main, so the commit stays one add + one bind with no
              ;; wrap-board move for the adapter to untangle.
              new-shape
              (cts/setup-shape
               {:id new-id
                :type :frame
                :name "New Component"
                :x (+ (:x container) 24)
                :y (+ (:y container) 24)
                :width 120
                :height 48
                :fills [{:fill-color "#6750a4" :fill-opacity 1}]
                :parent-id (:id container)
                :frame-id (:id container)})
              objects' (assoc objects new-id new-shape)
              changes  (-> (pcb/empty-changes it page-id)
                           (pcb/with-objects objects)
                           (pcb/add-object new-shape {:ignore-touched true}))
              undo-id  (js/Symbol)]
          (try
            (let [[root component-id changes']
                  ;; generate-add-component takes SHAPE OBJECTS, not ids
                  ;; (same as the ordinary add-component flow).
                  (cll/generate-add-component changes
                                              [new-shape]
                                              objects'
                                              page-id
                                              file-id
                                              cfsh/prepare-create-artboard-from-selection)]
              (rx/of (dwu/start-undo-transaction undo-id)
                     (dch/commit-changes changes')
                     (dws/select-shapes (d/ordered-set (:id root)))
                     (dwu/commit-undo-transaction undo-id)
                     (ptk/data-event :layout/update {:ids [new-id]})
                     (ptk/data-event ::created-component {:component-id component-id
                                                          :page-id page-id})))
            (catch :default e
              ;; A failed create must leave no ghost shape; surface the
              ;; validation payload for diagnosis before rolling back.
              (js/console.error
               "dse-create-failed"
               (str (ex-message e))
               (some-> e ex-data :app.common.schema/explain :errors (->> (mapv #(dissoc % :schema)))))

              (rx/empty))))))))

;; --- Sidebar affordance (Design System page only) --------------------------

(mf/defc insert-panel*
  {::mf/private true}
  []
  (let [file       (mf/deref refs/file)
        page-id    (mf/use-ctx ctx/current-page-id)
        page       (get-in file [:data :pages-index page-id])
        {:keys [visible? reason can-create? can-insert? has-components?]}
        (insert-panel-state file page)
        containers (->> (writable-containers file)
                        (sort-by :label)
                        (vec))
        components (->> (ctkl/components-seq (:data file))
                        (sort-by (fn [component]
                                   (str/lower-case (or (some-> component :name str) ""))))
                        (vec))
        target-ref    (mf/use-ref nil)
        component-ref (mf/use-ref nil)
        target-id*    (mf/use-state "")
        component-id* (mf/use-state "")
        target-valid? (some #(= (str (:container-id %)) @target-id*) containers)
        component-valid? (some #(= (str (:id %)) @component-id*) components)

        on-insert
        (mf/use-fn
         (mf/deps containers components)
         (fn []
           (let [target-value   (some-> (mf/ref-val target-ref) (.-value))
                 component-value (some-> (mf/ref-val component-ref) (.-value))
                 target   (some #(when (= (str (:container-id %)) target-value) %)
                                containers)
                 component (some #(when (= (str (:id %)) component-value) %)
                                 components)]
             (when (and target component)
               (st/emit! (insert-into-source
                          {:component-id (:id component)
                           :container-id (:container-id target)
                           :page-id (:page-id target)}))))))
        on-create
        (mf/use-fn
         (mf/deps containers)
         (fn []
           (let [target-value (some-> (mf/ref-val target-ref) (.-value))
                 target (some #(when (= (str (:container-id %)) target-value) %)
                              containers)]
             (when target
               (st/emit! (create-component-in-source
                          {:container-id (:container-id target)
                           :page-id (:page-id target)}))))))]

    (when visible?
      [:details {:class (stl/css :insert-panel)
                 :data-testid "dse-insert-panel"}
       [:summary {:class (stl/css :insert-summary)} "添加组件…"]
       [:div {:class (stl/css :insert-fields)}
        [:p {:class (stl/css :insert-hint)}
         "添加到源页面，Design System 展示会自动更新。"]
        (case reason
          :read-only
          [:div {:data-testid "dse-insert-reason"}
           "当前包为只读，无法写入源页面"]

          :no-container
          [:div {:data-testid "dse-insert-reason"}
           "没有可写源容器：先在普通页面创建一个 Frame"]

          nil
          [:> mf/Fragment #js {}
           [:label {:class (stl/css :insert-label)}
            "源页面 / 容器"
            [:select {:data-testid "dse-insert-target"
                      :class (stl/css :insert-select)
                      :ref target-ref
                      :on-change #(reset! target-id* (.. % -target -value))
                      :default-value ""}
             [:option {:value ""} "选择可写源容器…"]
             (for [container containers]
               ^{:key (str (:container-id container))}
               [:option {:value (str (:container-id container))}
                (:label container)])]]

        ;; Creating the FIRST component needs no existing component, so the
        ;; create entry is available on an empty package (DSE-R05); only the
        ;; insert-an-instance section is gated by available components.
           (when-not has-components?
             [:div {:data-testid "dse-insert-no-components"
                    :class (stl/css :insert-hint)}
              "暂无可用组件，可以在源页面新建。"])

           (when can-insert?
             [:> mf/Fragment #js {}
              [:label {:class (stl/css :insert-label)}
               "已有组件"
               [:select {:data-testid "dse-insert-component"
                         :class (stl/css :insert-select)
                         :ref component-ref
                         :on-change #(reset! component-id* (.. % -target -value))
                         :default-value ""}
                [:option {:value ""} "选择组件变体…"]
                (for [component components]
                  ^{:key (str (:id component))}
                  [:option {:value (str (:id component))}
                   (str (when (seq (:path component)) (str (:path component) " / "))
                        (or (some-> component :name str) "Unnamed"))])]]])

           [:div {:class (stl/css :insert-actions)}
            (when can-insert?
              [:> button* {:data-testid "dse-insert-button"
                           :variant "secondary"
                           :disabled (not (and target-valid? component-valid?))
                           :on-click on-insert}
               "插入实例"])
            (when can-create?
              [:> button* {:data-testid "dse-create-button"
                           :variant "secondary"
                           :disabled (not target-valid?)
                           :on-click on-create}
               "新建组件"])]])]])))
