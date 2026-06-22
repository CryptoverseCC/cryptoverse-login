import React from "react";

import Breadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";

export interface NavProps {
  origin: string;
  children: React.ReactNode;
  className?: any;
}

// Breadcrumb shown in the AppBar: the relying-party origin (accent link) ∙ the
// current step label (muted). Styled to the Vault system — muted separators and
// text, accent link, no shouting.
export const Nav: React.FC<NavProps> = ({ origin, children, className }) => {
  const href = `https://${origin}/`;
  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      separator="∙"
      className={className}
      sx={{
        color: "text.secondary",
        fontSize: "0.875rem",
        "& .MuiBreadcrumbs-separator": { color: "text.disabled", mx: 1 },
      }}
    >
      <Link
        href={href}
        onClick={() => window.location.assign(href)}
        sx={{ color: "primary.main", fontWeight: 500 }}
      >
        {origin}
      </Link>
      {children}
    </Breadcrumbs>
  );
};
