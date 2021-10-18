import React from "react";

import Breadcrumbs from "@material-ui/core/Breadcrumbs";
import Link from "@material-ui/core/Link";

export interface NavProps {
  origin: string;
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
