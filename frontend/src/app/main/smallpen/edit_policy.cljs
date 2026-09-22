;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.

(ns app.main.smallpen.edit-policy
  (:require [clojure.string :as str]))

(defn design-system-page?
  [page]
  (true? (get-in page [:plugin-data :smallpen "design-system-page"])))

(defn current-page-locked?
  [state]
  (design-system-page?
   (get-in state [:files (:current-file-id state) :data :pages-index (:current-page-id state)])))

(defn source-shape?
  [shape]
  (= "source" (get-in shape [:plugin-data :smallpen "design-system"])))

(defn- change-page
  [pages change]
  (get pages (or (:page-id change)
                 (when (#{:mod-page :del-page :mov-page} (:type change)) (:id change))
                 (:main-instance-page change))))

(def ^:private derived-attributes
  #{:position-data :selrect :points :transform :transform-inverse})

(defn- bookkeeping?
  [change]
  (or (= :reg-objects (:type change))
      (and (= :mod-obj (:type change))
           (every? #(contains? derived-attributes (:attr %)) (:operations change)))))

(defn- blocked-change
  [pages change]
  (when-let [page (let [page (change-page pages change)]
                   (when (design-system-page? page) page))]
    (when-not (bookkeeping? change)
      (let [shape (get-in page [:objects (:id change)])
            attrs (set (map :attr (:operations change)))]
        (cond
          (not= :mod-obj (:type change)) :structure
          (not (source-shape? shape)) :decoration
          (some #(or (#{:shapes :parent-id :frame-id :component-id :component-file
                         :component-root :main-instance :shape-ref} %)
                     (str/starts-with? (name (or % :none)) "layout")) attrs) :structure
          (and (some attrs [:x :y])
               (not (some attrs [:width :height]))) :position)))))

(defn commit-block-reason
  "Gate BEFORE the local commit, undo stack and persistence buffer. Reject
  the complete user action, never silently save half of a structural edit.
  Source-targeted creation remains valid even while the DS page is open."
  [file changes]
  (let [pages (get-in file [:data :pages-index])]
    ;; Preserve renderer measurement commits: they update local text geometry
    ;; and are already accepted as canonical no-ops by the adapter.
    (some #(blocked-change pages %) changes)))

(defn blocked-message
  [reason]
  (case reason
    :decoration "这是自动生成的展示框，不能修改。请选择 Token 或组件内容。"
    :position "DS 展示位置由系统排列；请到源位置调整组件布局。"
    "DS 仅支持属性编辑；新增、删除、粘贴和结构调整请到源页面操作。"))
