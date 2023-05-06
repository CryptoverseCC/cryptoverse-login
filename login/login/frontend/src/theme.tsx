import red from "@material-ui/core/colors/red";
import { createTheme } from "@material-ui/core/styles";

// A custom theme for this app
const theme = createTheme({
  palette: {
    primary: {
      main: "#3366cc",
    },
    secondary: {
      main: "#1100bb",
    },
    error: {
      main: red.A400,
    },
    background: {
      default: "#fff",
    },
  },
});

export default theme;
