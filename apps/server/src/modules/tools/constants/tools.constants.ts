export const toolNames = ["chrome", "cutout"] as const;

export const chromeVersion = "158.0.8127.36";
export const chromeUrl = `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/linux64/chrome-linux64.zip`;
export const chromeSha256 = "dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7";
export const chromeDownloadMb = 200;
export const chromeImagePath = "/opt/runelay-chrome/chrome";
export const systemChromium = ["chromium", "chromium-browser"];

export const cutoutVersion = "1.32.0-1";
export const cutoutDownloadMb = 260;
export const cutoutImageDir = "/opt/runelay-cutout";
export const cutoutModel = {
  name: "isnet-general-use.onnx",
  url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
  sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
};
export const pipWheel = {
  name: "pip-26.3-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/07/25/ee8c38ae72d66b844ce8eb9711ba905dba21ca1a8a0c960057c41cd23337/pip-26.3-py3-none-any.whl",
  sha256: "f3b60b20ffaadd4415ed7957212a38ac63fa4c5fa375bd0f4a797777940fad13",
};
export const cutoutRequirements: Array<{ name: string; version: string; hashes: string[] }> = [
  {
    name: "onnxruntime",
    version: "1.32.0",
    hashes: [
      "2303372a85299b6757b0e11e1cbf13e410ddf7e10c37f4b37e99d1c90e7daf7c",
      "5a34fc4dfeb5a7b4a74c95dcba1e773d722abda720b474edf1b0c419dc6d163d",
      "e36c187006e7a7c8b8d6d57f1a209dd63f52430dca6c282b177718ad6b841054",
      "99e1074c4b2197accd5073052a465361be17b89c093b8ffb6e6bd8f986c52df8",
    ],
  },
  {
    name: "numpy",
    version: "2.4.6",
    hashes: [
      "0ab0a9c4ffb1a6d95ef519fe4247dba8eb6b18ad93999f76b7f657039acabd47",
      "89cd468399cfd2504718f0ba50e410dca55a170b61a02ad92bb18c8a65186e93",
      "5f9fb9157b4ce2971008323afe46053787b526ef624fea915b261468a8421a0f",
      "90f9849678c75fe7afa2d348ac842c168b0a4d3d61919687216dfc547976d853",
    ],
  },
  {
    name: "pillow",
    version: "13.0.0",
    hashes: [
      "7c88c10dd432f3b39ccdafc9ed81d0c21b8fd634502574da76d1bfa4fe2c76d0",
      "a625df9a2a5597fa5e5266e01aefc82604bb85d291e3547981e863560d75da6c",
      "8bf295fe459343bc6093c8e5e0df60bfa189e0fcb775a22e2c2488fdeccc6c0d",
      "42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca",
    ],
  },
  {
    name: "scipy",
    version: "1.17.1",
    hashes: [
      "744b2bf3640d907b79f3fd7874efe432d1cf171ee721243e350f55234b4cec4c",
      "43af8d1f3bea642559019edfe64e9b11192a8978efbd1539d7bc2aaa23d92de4",
      "e19ebea31758fac5893a2ac360fedd00116cbb7628e650842a6691ba7ca28a21",
      "02ae3b274fde71c5e92ac4d54bc06c42d80e399fec704383dcd99b301df37458",
    ],
  },
  {
    name: "protobuf",
    version: "7.36.2",
    hashes: [
      "e11e1f0180583a2af89db6a2ecd9e8dc40aa6d2988ca175bfd0e6d12ea72d74e",
      "89f23aa53c24553a2416fd4fd1ec06f74fa42b14b546d8883128813f775bbfd2",
      "bdb3a345d48db958e6ce1f18e508beb0cc981d64f24088427549c866cd039f1e",
    ],
  },
  {
    name: "flatbuffers",
    version: "25.12.19",
    hashes: ["7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4"],
  },
  { name: "packaging", version: "26.3", hashes: ["d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c"] },
];
export const cutoutImports = "import onnxruntime, numpy, PIL.Image, scipy.ndimage; print(onnxruntime.__version__)";

export const downloadTimeoutMs = 15 * 60 * 1000;
export const installTimeoutMs = 15 * 60 * 1000;
export const checkTimeoutMs = 60_000;
