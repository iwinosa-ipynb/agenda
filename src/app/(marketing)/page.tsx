import { AdvertiserBenefits } from "@/components/marketing/advertiser-benefits";
import { CreatorBenefits } from "@/components/marketing/creator-benefits";
import { ExampleCampaign } from "@/components/marketing/example-campaign";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { TrustSafety } from "@/components/marketing/trust-safety";

export default function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <CreatorBenefits />
      <AdvertiserBenefits />
      <ExampleCampaign />
      <TrustSafety />
    </>
  );
}
