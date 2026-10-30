import { Kick } from "@/components/ui/primitives";

export const AuthHeading = ({
  kick,
  title,
  sub,
}: {
  kick?: string;
  title: string;
  sub?: React.ReactNode;
}) => (
  <div className="mb-7">
    {kick ? <Kick className="mb-2">{kick}</Kick> : null}
    <h1 className="text-[31px] leading-[1.06] tracking-[-0.025em] sm:text-[36px]">{title}</h1>
    {sub ? <p className="mt-2.5 max-w-[44ch] text-[14px] text-neutral-300">{sub}</p> : null}
  </div>
);
