// 数据集页（#/datasets）：原资源库下块整体成页（2026-08-29 拆页）。
// 四个 tab（回归数据集 / 模拟测试 / 红队用例集 / 线上评估）都在 DatasetsBlock 里，
// 这层只是页面壳：标题 + 页面 testid。
import DatasetsBlock from "./DatasetsBlock";
import "./resources.css";
import PageHeader from "../../components/layout/PageHeader";

export default function DatasetsPage() {
  return (
    <section data-testid="page-datasets">
      <PageHeader title="数据集" />
      <DatasetsBlock />
    </section>
  );
}
