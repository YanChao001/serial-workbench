import { useI18n } from "@/providers/i18n";

export default function Overview() {
  const { t } = useI18n();
  return (
    <section
      className="studio-page"
      data-testid="serial-workbench-shell"
      aria-label={t("shell.title")}
    >
      <h1 className="sr-only">{t("shell.title")}</h1>
    </section>
  );
}
