import React from "react";

import Breadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";

export interface NavProps {
  origin: string;
  children: React.ReactNode;
  className: any;
}

export const Nav: React.FC<NavProps> = ({ origin, children, className }) => {
  origin = `https://${origin}/`;
  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      separator="∙"
      className={className}
      color="inherit"
    >
      <Link
        color="inherit"
        href={origin}
        onClick={() => window.location.assign(origin)}
      >
        {origin}
      </Link>
      {children}
    </Breadcrumbs>
  );
};
