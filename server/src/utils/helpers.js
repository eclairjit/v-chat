import fs from "fs";

export const removeLocalFile = (localFilePath) => {
  fs.unlinkSync(localFilePath, (err) => {
    if (err) {
      console.log("Error while removing local file. Error: ", err);
    } else {
      console.log(
        "Local file removed successfully. File path: ",
        localFilePath
      );
    }
  });
};

export const getStatisFilePath = (req, fileName) => {
  return `$(req.protocol)://${req.get("host")}/images/${fileName}`;
};

export const getLocalPath = (fileName) => {
  return `public/images/${fileName}`;
};
