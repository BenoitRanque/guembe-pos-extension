# Guembe POS extension

Deployemnt instructions

Compress all JS files and the Index.ard file into a single .zip archive.

Deploy at `https://<hana host>:40000/ExtensionManager`

Do not forget to assign the extension.

The apis can be accessed at `https://<hana host>:50000/b1s/v1/script/<partner>/<name>`

Where partner is the partner defined in Index.ard, and name is the name defined in the same file