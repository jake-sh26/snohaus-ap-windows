import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Construction, Calendar, Users, Receipt, Wrench, Gift } from "lucide-react";

// Placeholder landing page for the upcoming Payroll module.
// Once the schema and ingestion modules land (PRs #2+), this page will show
// current pay periods, an ADP export queue, and quick links to the sub-sections.
export default function Payroll() {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commission, PM, and tip calculations across all three entities.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <Construction className="size-3" /> Coming soon
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What this module will do</CardTitle>
          <CardDescription>
            Replaces the manual weekly + monthly commission/PM/tip workflow with a single source
            of truth that feeds ADP Run directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <FeatureRow
              icon={Receipt}
              title="Weekly base commissions"
              desc="Net POS sales by staff from Shopify + Easyrent, Greenvale only. Computed every Monday morning for the prior Mon–Sun."
            />
            <FeatureRow
              icon={Wrench}
              title="Monthly PMs"
              desc="Tuning/service work orders from Easyrent, paid in the first weekly payroll of the next month."
            />
            <FeatureRow
              icon={Calendar}
              title="Monthly tips"
              desc="Pulled from Lighthouse Transaction Manager (Shift4) per clerk, net of credit card fee."
            />
            <FeatureRow
              icon={Gift}
              title="SPIF rules engine"
              desc="Per-vendor / per-product bonuses (e.g. $3 per BootDoc unit sold). Configurable from the UI."
            />
            <FeatureRow
              icon={Users}
              title="Employee mappings"
              desc="One central place to map Shopify staff IDs, Easyrent user IDs, LTM clerk #s, and ADP employee IDs."
            />
            <FeatureRow
              icon={Receipt}
              title="ADP Run export"
              desc="Generates per-entity paydata CSVs ready to import into each store's ADP Run account."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entities</CardTitle>
          <CardDescription>The three legal entities this platform serves.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <EntityRow
              name="SD Ski and Patio Inc"
              location="Greenvale"
              cadence="Weekly payroll"
              features="Commissions • PMs • Tips • SPIFs"
            />
            <EntityRow
              name="SH Huntington Inc"
              location="Huntington"
              cadence="Bi-weekly payroll"
              features="Easyrent data only (no commission earnings)"
            />
            <EntityRow
              name="SH Hempstead Inc"
              location="Hempstead"
              cadence="Bi-weekly payroll"
              features="Easyrent data only (no commission earnings)"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeatureRow({
  icon: Icon,
  title,
  desc,
}: {
  icon: any;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex gap-3 p-3 rounded-md border bg-card">
      <Icon className="size-4 mt-0.5 text-muted-foreground shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
      </div>
    </div>
  );
}

function EntityRow({
  name,
  location,
  cadence,
  features,
}: {
  name: string;
  location: string;
  cadence: string;
  features: string;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-md border bg-card">
      <div className="min-w-0">
        <div className="text-sm font-medium">{location}</div>
        <div className="text-xs text-muted-foreground">
          {name} • {cadence}
        </div>
      </div>
      <div className="text-xs text-muted-foreground text-right shrink-0 ml-3">{features}</div>
    </div>
  );
}
